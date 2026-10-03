/** Shared URL policy. No applicant data or credentials belong in this file. */
const JOBKIT_API_ORIGIN = "http://127.0.0.1:8765";

function isSupportedApplicationUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname;
    if (["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(host)) {
      return /^\/[^/]+\/jobs\/[^/]+(?:\/confirmation)?\/?$/.test(url.pathname) || url.pathname === "/embed/job_app";
    }
    if (["jobs.lever.co", "jobs.ashbyhq.com"].includes(host)) return /^\/[^/]+\/[^/]+/.test(url.pathname);
    if (host === "stripe.com") return url.pathname.startsWith("/careers/");
    if (host === "www.pinterestcareers.com") return /^\/(jobs|job)\//.test(url.pathname);
    if (host === "discord.com") return url.pathname.startsWith("/careers/");
    return false;
  } catch { return false; }
}

function sanitizedApplicationUrl(value) {
  if (!isSupportedApplicationUrl(value)) throw new Error("Unsupported application URL");
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (!["gh_jid", "for", "token"].includes(key)) url.searchParams.delete(key);
  }
  return url.href;
}

function localApiUrl(path) {
  const url = new URL(path, JOBKIT_API_ORIGIN);
  if (url.origin !== JOBKIT_API_ORIGIN || url.username || url.password || !url.pathname.startsWith("/api/") || url.hash) {
    throw new Error("Only the local Jobkit API is allowed");
  }
  return url.href;
}

function localResumeUrl(path) {
  const url = new URL(localApiUrl(path));
  const valid = /^\/api\/ledger\/applications\/[1-9]\d*\/resume$/.test(url.pathname) ||
    /^\/api\/projects\/[A-Za-z0-9_-]+\/approved\/[A-Za-z0-9_-]+\/pdf$/.test(url.pathname);
  if (!valid || url.search) throw new Error("Unsupported local resume endpoint");
  return url.href;
}
