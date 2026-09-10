import { createServer, type Server } from "node:http";

const members: Record<string, { name: string; savings: string; checking: string }> = {
  "10001": { name: "Avery Brooks", savings: "$4,321.09", checking: "$1,204.18" },
  "20002": { name: "Jordan Lee", savings: "$8,004.31", checking: "$982.44" }
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>'"]/g, (character) => {
    const escaped: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;"
    };
    return escaped[character] ?? character;
  });

const shell = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} - Heritage Core 7</title>
  <style>
    body { margin: 0; background: #d7d7cf; color: #111; font: 14px Arial, sans-serif; }
    .top { background: #17365d; color: white; padding: 9px 14px; font-weight: bold; }
    .sub { background: #eee; border-bottom: 1px solid #888; padding: 5px 14px; }
    table.layout { width: 760px; margin: 22px auto; border-collapse: collapse; background: white; border: 1px solid #777; }
    table.layout td { padding: 8px; }
    .section { background: #d9e5f4; font-weight: bold; border-bottom: 1px solid #777; }
    .field { width: 240px; border: 1px inset #aaa; padding: 4px; }
    .button { border: 1px outset #777; background: #eee; padding: 4px 14px; color: #111; text-decoration: none; }
    .result { width: 100%; border-collapse: collapse; }
    .result th, .result td { border: 1px solid #999; padding: 7px; text-align: left; }
    .result th { background: #eee; }
    .error { border: 1px solid #9b1c1c; background: #fff0f0; color: #7a1111; padding: 10px; }
    .notice { border: 1px solid #9a6b00; background: #fff9d9; padding: 10px; }
    .muted { color: #555; font-size: 12px; }
  </style>
</head>
<body>
  <div class="top">Heritage Core 7 :: Member Servicing</div>
  <div class="sub">Training tenant &nbsp;|&nbsp; Synthetic records only</div>
  ${body}
</body>
</html>`;

const lookupPage = (): string =>
  shell(
    "Member Lookup",
    `<form method="get" action="/results">
      <table class="layout">
        <tr><td class="section" colspan="2">Member Lookup</td></tr>
        <tr>
          <td width="180"><label for="member-number">Member number</label></td>
          <td><input class="field" id="member-number" name="memberId" inputmode="numeric" autocomplete="off"></td>
        </tr>
        <tr><td></td><td><button class="button" type="submit">Search members</button></td></tr>
        <tr><td colspan="2" class="muted">Demo records: 10001; 20002 simulates one recoverable session timeout. 99999 is not found; 40300 is denied.</td></tr>
      </table>
    </form>`
  );

const resultsPage = (memberId: string, resumed: boolean): string => {
  if (memberId === "40300") {
    return shell(
      "Permission Denied",
      `<table class="layout"><tr><td class="section">Search Result</td></tr><tr><td><div class="error">Permission denied: your role cannot view this member.</div></td></tr></table>`
    );
  }
  if (memberId === "20002" && !resumed) {
    return shell(
      "Session Expired",
      `<table class="layout"><tr><td class="section">Session Notice</td></tr><tr><td><div class="notice">Session expired while loading the result.</div></td></tr><tr><td><a class="button" href="/results?memberId=20002&amp;resumed=1">Resume session</a></td></tr></table>`
    );
  }
  const member = members[memberId];
  if (member === undefined) {
    return shell(
      "No Results",
      `<table class="layout"><tr><td class="section">Search Result</td></tr><tr><td><div class="notice">No member found for that member number.</div></td></tr><tr><td><a href="/">Return to lookup</a></td></tr></table>`
    );
  }
  return shell(
    "Search Results",
    `<table class="layout">
      <tr><td class="section">Search Results</td></tr>
      <tr><td>
        <table class="result">
          <tr><th>Member number</th><th>Name</th><th>Action</th><th>Status</th></tr>
          <tr><td>${escapeHtml(memberId)}</td><td>${escapeHtml(member.name)}</td><td><a href="/member/${escapeHtml(memberId)}">Open member</a></td><td>Active</td></tr>
        </table>
      </td></tr>
    </table>`
  );
};

const detailPage = (memberId: string): string => {
  const member = members[memberId];
  if (member === undefined) return resultsPage(memberId, true);
  return shell(
    "Member Details",
    `<table class="layout">
      <tr><td class="section" colspan="2">Member Details</td></tr>
      <tr><td>Member number</td><td>${escapeHtml(memberId)}</td></tr>
      <tr><td>Member name</td><td>${escapeHtml(member.name)}</td></tr>
      <tr><td>Checking balance</td><td>${escapeHtml(member.checking)}</td></tr>
      <tr><td>Savings balance</td><td>${escapeHtml(member.savings)}</td></tr>
      <tr><td colspan="2"><a href="/">New lookup</a> &nbsp; <button type="button">Close account</button></td></tr>
    </table>`
  );
};

export function createTargetServer(port = 4173): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `127.0.0.1:${port}`}`);
    let html: string;
    let status = 200;
    if (url.pathname === "/") {
      html = lookupPage();
    } else if (url.pathname === "/results") {
      html = resultsPage(url.searchParams.get("memberId") ?? "", url.searchParams.get("resumed") === "1");
    } else if (/^\/member\/\d+$/.test(url.pathname)) {
      html = detailPage(url.pathname.split("/").at(-1) ?? "");
    } else {
      status = 404;
      html = shell("Not Found", `<p>Page not found.</p>`);
    }
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'"
    });
    response.end(html);
  });
}

export async function startTargetServer(port = 4173): Promise<Server> {
  const server = createTargetServer(port);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
