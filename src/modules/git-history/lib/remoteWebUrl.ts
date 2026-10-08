export type RemoteWebHost = "github" | "gitlab" | "bitbucket";

export type RemoteWebInfo = {
  host: RemoteWebHost;
  hostname: string;
  owner: string;
  repo: string;
  baseUrl: string;
};

const SUPPORTED_HOSTS: Record<string, RemoteWebHost> = {
  "github.com": "github",
  "www.github.com": "github",
  "gitlab.com": "gitlab",
  "www.gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
  "www.bitbucket.org": "bitbucket",
};

export function parseRemoteWebUrl(
  raw: string | null | undefined,
): RemoteWebInfo | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.length > 8192 ||
    /[\u0000-\u0020\u007f]/.test(trimmed)
  ) {
    return null;
  }

  let hostname: string;
  let pathname: string;

  if (trimmed.includes("://")) {
    try {
      const url = new URL(trimmed);
      if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol)) {
        return null;
      }
      hostname = url.hostname;
      pathname = url.pathname;
    } catch {
      return null;
    }
  } else {
    const scpMatch = trimmed.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
    if (!scpMatch) return null;
    hostname = scpMatch[1];
    pathname = scpMatch[2];
  }

  const host: RemoteWebHost | undefined = Object.getOwnPropertyDescriptor(
    SUPPORTED_HOSTS,
    hostname.toLowerCase(),
  )?.value;
  if (!host) return null;

  const parts = pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (
    parts.length < 2 ||
    (host !== "gitlab" && parts.length !== 2) ||
    parts.some(
      (part) =>
        !part || !/^[\w.-]+$/.test(part) || part === "." || part === "..",
    )
  )
    return null;
  const owner = parts.slice(0, -1).join("/");
  const repo = parts[parts.length - 1];
  return {
    host,
    hostname: hostname.toLowerCase(),
    owner,
    repo,
    baseUrl: `https://${hostname.toLowerCase()}/${owner}/${repo}`,
  };
}

export function commitWebUrl(info: RemoteWebInfo, sha: string): string {
  switch (info.host) {
    case "github":
      return `${info.baseUrl}/commit/${sha}`;
    case "gitlab":
      return `${info.baseUrl}/-/commit/${sha}`;
    case "bitbucket":
      return `${info.baseUrl}/commits/${sha}`;
  }
}

export function hostLabel(info: RemoteWebInfo): string {
  switch (info.host) {
    case "github":
      return "View on GitHub";
    case "gitlab":
      return "View on GitLab";
    case "bitbucket":
      return "View on Bitbucket";
  }
}
