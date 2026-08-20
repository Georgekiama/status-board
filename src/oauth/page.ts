/**
 * The sign-in page shown at /oauth/authorize.
 *
 * There are no user accounts (plan.md section 7 puts them out of scope), so this
 * is one shared password held in BOARD_PASSWORD. It is the gate that stops
 * anybody who merely knows the URL from minting a token for themselves.
 *
 * Styled to match the board so it does not look like a phishing page to the
 * person being asked for a password.
 */

export interface AuthorizePageParams {
  /** Hidden fields to replay on submit. */
  fields: Record<string, string>;
  clientName?: string | null;
  error?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderAuthorizePage(params: AuthorizePageParams): string {
  const hidden = Object.entries(params.fields)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(
      ([name, value]) =>
        '<input type="hidden" name="' + escapeHtml(name) + '" value="' + escapeHtml(value) + '" />',
    )
    .join("\n      ");

  const who = params.clientName ? escapeHtml(params.clientName) : "An application";
  const error = params.error
    ? '<p class="error" role="alert">' + escapeHtml(params.error) + "</p>"
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize — Lit &amp; More Status Board</title>
<style>
  :root{
    --ink:#2A2A22; --ink-soft:#5B5A4E; --cream:#F1ECDD; --card:#FAF7EE;
    --olive:#5B6144; --line:#DFD8C2; --rust:#B14926;
  }
  *{box-sizing:border-box;}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:var(--cream);color:var(--ink);
    font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;padding:24px;}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;
    padding:28px 30px;max-width:26rem;width:100%;}
  h1{font-size:19px;margin:0 0 6px;}
  .sub{font-size:13.5px;color:var(--ink-soft);margin:0 0 20px;line-height:1.55;}
  .who{font-weight:600;color:var(--ink);}
  label{display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;}
  input[type=password]{width:100%;font-size:14px;padding:10px 12px;border:1px solid var(--line);
    border-radius:5px;background:#fff;font-family:inherit;}
  input[type=password]:focus{outline:2px solid var(--olive);outline-offset:1px;}
  button{margin-top:16px;width:100%;background:var(--olive);color:#fff;border:none;border-radius:5px;
    padding:11px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;}
  button:hover{opacity:.92;}
  .error{background:#F3DCD2;border:1px solid #D69377;color:#8A3418;font-size:13px;
    border-radius:5px;padding:9px 11px;margin:0 0 16px;}
  .scopes{margin:18px 0 0;padding:12px 14px;background:var(--cream);border-radius:5px;
    font-size:12.5px;color:var(--ink-soft);line-height:1.6;}
  .scopes strong{color:var(--ink);}
  .foot{margin:18px 0 0;font-size:11.5px;color:var(--ink-soft);line-height:1.5;}
</style>
</head>
<body>
  <form class="card" method="post" action="/oauth/authorize">
    <h1>Authorize access</h1>
    <p class="sub"><span class="who">${who}</span> is asking to read and update the
      Lit &amp; More status board. Enter the board password to allow it.</p>
    ${error}
    <label for="password">Board password</label>
    <input id="password" name="password" type="password" autocomplete="current-password"
      autofocus required />
    ${hidden}
    <button type="submit">Allow access</button>
    <div class="scopes">
      This grants: <strong>read the board</strong> and <strong>replace the board</strong>.
      Every change is version-stamped and the previous version is kept, so an
      unwanted edit can be rolled back.
    </div>
    <p class="foot">If you were not expecting this, close this page. Access can be
      revoked at any time from the server.</p>
  </form>
</body>
</html>
`;
}

/** Shown when the flow cannot even start, e.g. a bad redirect_uri. */
export function renderErrorPage(title: string, detail: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — Status Board</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#F1ECDD;color:#2A2A22;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;padding:24px;}
  .card{background:#FAF7EE;border:1px solid #DFD8C2;border-radius:8px;padding:26px 28px;max-width:28rem;}
  h1{font-size:18px;margin:0 0 8px;}
  p{font-size:13.5px;color:#5B5A4E;line-height:1.6;margin:0;}
  code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;}
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
  </div>
</body>
</html>
`;
}
