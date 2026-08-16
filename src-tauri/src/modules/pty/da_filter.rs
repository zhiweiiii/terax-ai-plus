const ESC: u8 = 0x1b;
const LBRACKET: u8 = 0x5b;
const FINAL_C: u8 = 0x63;
const FINAL_N: u8 = 0x6e;
const PREFIX_GT: u8 = 0x3e;
const PREFIX_EQ: u8 = 0x3d;

const DA1_REPLY: &[u8] = b"\x1b[?1;2c";
const DA2_REPLY: &[u8] = b"\x1b[>0;276;0c";
// pwsh/PSReadLine blocks on a startup cursor-position query (ESC[6n) before any
// renderer slot is bound to answer it; on a fresh console the cursor is at home.
const DSR_CPR_REPLY: &[u8] = b"\x1b[1;1R";

const HOLD_MAX: usize = 256;

#[derive(Clone, Copy)]
enum State {
    Idle,
    AfterEsc,
    InsideCsi,
}

pub struct DaFilter {
    state: State,
    hold: Vec<u8>,
    cpr_replied: bool,
    saw_output: bool,
}

impl DaFilter {
    pub fn new() -> Self {
        DaFilter {
            state: State::Idle,
            hold: Vec::with_capacity(16),
            cpr_replied: false,
            saw_output: false,
        }
    }

    pub fn process<F: FnMut(&[u8])>(
        &mut self,
        input: &[u8],
        out: &mut Vec<u8>,
        mut respond: F,
    ) {
        if matches!(self.state, State::Idle) && !input.contains(&ESC) {
            out.extend_from_slice(input);
            if !input.is_empty() {
                self.saw_output = true;
            }
            return;
        }

        for &b in input {
            match self.state {
                State::Idle => {
                    if b == ESC {
                        self.state = State::AfterEsc;
                        self.hold.clear();
                        self.hold.push(b);
                    } else {
                        out.push(b);
                    }
                }
                State::AfterEsc => {
                    if b == LBRACKET {
                        self.state = State::InsideCsi;
                        self.hold.push(b);
                    } else if b == ESC {
                        out.extend_from_slice(&self.hold);
                        self.hold.clear();
                        self.hold.push(b);
                    } else {
                        out.extend_from_slice(&self.hold);
                        out.push(b);
                        self.hold.clear();
                        self.state = State::Idle;
                    }
                }
                State::InsideCsi => {
                    self.hold.push(b);
                    if (0x40..=0x7e).contains(&b) {
                        if b == FINAL_C {
                            let middle = &self.hold[2..self.hold.len() - 1];
                            let is_response =
                                middle.contains(&b'?') || middle.contains(&b';');
                            let is_startup_query = !self.saw_output && out.is_empty();
                            let prefix = middle.first().copied().unwrap_or(0);
                            if is_response || !is_startup_query {
                                out.extend_from_slice(&self.hold);
                            } else {
                                match prefix {
                                    PREFIX_GT => respond(DA2_REPLY),
                                    PREFIX_EQ => {}
                                    0 | b'0'..=b'9' => respond(DA1_REPLY),
                                    _ => out.extend_from_slice(&self.hold),
                                }
                            }
                        } else if b == FINAL_N
                            && self.hold.len() == 4
                            && self.hold[2] == b'6'
                            && !self.cpr_replied
                            && !self.saw_output
                            && out.is_empty()
                        {
                            respond(DSR_CPR_REPLY);
                            self.cpr_replied = true;
                        } else {
                            out.extend_from_slice(&self.hold);
                        }
                        self.hold.clear();
                        self.state = State::Idle;
                    } else if self.hold.len() >= HOLD_MAX {
                        out.extend_from_slice(&self.hold);
                        self.hold.clear();
                        self.state = State::Idle;
                    }
                }
            }
        }
        if !out.is_empty() {
            self.saw_output = true;
        }
    }
}


