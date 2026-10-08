export type Segment = {
  label: string;
  fullPath: string;
  isHome: boolean;
};

const WINDOWS_DRIVE = /^([A-Za-z]:)(.*)$/;

function normalize(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/\?\/(?=[A-Za-z]:\/)/, "");
}

export function segmentsFromCwd(cwd: string, home: string | null): Segment[] {
  const normCwd = normalize(cwd);
  const rawHome = home !== null ? normalize(home) : null;
  const trimmedHome = rawHome?.replace(/\/+$/, "");
  const normHome = !rawHome
    ? null
    : !trimmedHome
      ? "/"
      : /^[A-Za-z]:$/.test(trimmedHome)
        ? `${trimmedHome}/`
        : trimmedHome;
  const windowsPath = WINDOWS_DRIVE.test(normCwd) || normCwd.startsWith("//");
  const comparedCwd = windowsPath ? normCwd.toLowerCase() : normCwd;
  const comparedHome =
    normHome === null ? null : windowsPath ? normHome.toLowerCase() : normHome;

  const usingHome =
    comparedHome !== null &&
    (comparedCwd === comparedHome ||
      comparedCwd.startsWith(
        comparedHome.endsWith("/") ? comparedHome : `${comparedHome}/`,
      ));

  let rootSegment: Segment;
  let tail: string;

  if (usingHome && normHome !== null) {
    rootSegment = { label: "~", fullPath: normHome, isHome: true };
    tail = normCwd.slice(normHome.length).replace(/^\//, "");
  } else {
    const uncMatch = /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(normCwd);
    const driveMatch = WINDOWS_DRIVE.exec(normCwd);
    if (uncMatch) {
      const share = `//${uncMatch[1]}/${uncMatch[2]}`;
      rootSegment = { label: share, fullPath: share, isHome: false };
      tail = uncMatch[3] ?? "";
    } else if (driveMatch) {
      const drive = driveMatch[1];
      rootSegment = { label: drive, fullPath: `${drive}/`, isHome: false };
      tail = driveMatch[2].replace(/^\//, "");
    } else {
      rootSegment = { label: "/", fullPath: "/", isHome: false };
      tail = normCwd.replace(/^\//, "");
    }
  }

  const parts = tail === "" ? [] : tail.split("/").filter(Boolean);
  const segments: Segment[] = [rootSegment];

  let acc = rootSegment.fullPath;
  for (const part of parts) {
    acc = acc.endsWith("/") ? `${acc}${part}` : `${acc}/${part}`;
    segments.push({ label: part, fullPath: acc, isHome: false });
  }
  return segments;
}
