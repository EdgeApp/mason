export function escape(value: string | number): string {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  )
}
export function page(
  title: string,
  content: string,
  navigation = '',
  interactive = false,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Mason</title><link rel="stylesheet" href="/assets/style.css">${interactive ? '<script type="module" src="/assets/catalog.js"></script>' : ''}</head><body><header><a class="brand" href="/">Mason<span>App distribution</span></a><nav>${navigation}</nav></header><main><h1>${escape(title)}</h1>${content}</main></body></html>`
}
export const stylesheet = `:root{font:16px system-ui,sans-serif;color:#e9edf3;background:#10151e;color-scheme:dark}*{box-sizing:border-box}body{margin:0}header{position:sticky;top:0;z-index:2;background:#10151ef5;max-width:1060px;margin:auto;display:flex;align-items:center;justify-content:space-between;padding:28px 24px;border-bottom:1px solid #2c3545}.brand{font-size:24px;font-weight:750;color:#fff;text-decoration:none}.brand span{display:block;font-size:12px;font-weight:450;color:#8d9bad;margin-top:3px}main{max-width:1060px;padding:36px 24px;margin:auto}h1{font-size:30px;margin:0 0 24px}h2{font-size:20px}p{line-height:1.6;color:#b3bfd0}a{color:#a9caff}nav{display:flex;gap:20px;align-items:center}.card{border:1px solid #2c3545;border-radius:14px;background:#18202d;padding:24px;margin-bottom:20px;max-width:700px}.button,button{display:inline-block;background:#b2d0ff;color:#101b2b;border:0;border-radius:8px;padding:12px 18px;font:inherit;font-weight:650;cursor:pointer;text-decoration:none}.register-device{background:#43d17d;color:#082615;white-space:nowrap}.device-state{font-size:14px;color:#b3bfd0}.device-id{overflow-wrap:anywhere}.secondary{background:#2c384d;color:#e9edf3}.danger{background:#5a2930;color:#ffccd0}form{margin:0}label{display:block;margin:16px 0 6px}input,select{display:block;border:1px solid #46526a;border-radius:7px;background:#10151e;color:#fff;font:inherit;padding:11px;width:100%;max-width:450px}small{display:block;color:#8d9bad;margin:7px 0}.row{padding:18px 0;border-bottom:1px solid #2c3545;display:flex;justify-content:space-between;gap:20px;align-items:center}.row:last-child{border:0}.row p{margin:5px 0;word-break:break-word}.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.notice{padding:16px;background:#223148;border-radius:8px}.stack{display:flex;flex-direction:column;align-items:flex-start;gap:12px}@media(max-width:600px){header,main{padding:22px 16px}.row{align-items:flex-start;flex-direction:column}nav{gap:12px}h1{font-size:26px}}`

export const catalogStyles = `.platforms{display:flex;gap:2px;padding:3px;border:1px solid #344057;border-radius:999px;background:#111923}.platforms a{padding:9px 11px;border-radius:999px;font-size:12px;text-decoration:none;color:#9dabc0;min-height:36px;display:flex;align-items:center}.platforms a[aria-current=true]{background:#b2d0ff;color:#101b2b}.intro{margin-top:-10px;margin-bottom:30px}.app-list,.build-list{max-width:850px}.app-card,.list-row{display:flex;align-items:center;justify-content:space-between;gap:22px;padding:24px;border:1px solid #2c3545;border-radius:12px;background:#18202d;margin-bottom:12px;color:#e9edf3;text-decoration:none;width:100%;text-align:left}.app-card:hover,.list-row:hover{background:#202c3e;border-color:#7089af}.app-card div{flex:1}.app-card h2{margin:0}.app-card small{overflow-wrap:anywhere}.app-index{color:#81a9dc;font-size:13px;font-variant-numeric:tabular-nums}.app-card:first-child{padding-top:30px;padding-bottom:30px;background:#1d2c43}.list-row strong{overflow-wrap:anywhere}.build-row{font-weight:400}.build-row strong{font-size:18px}.build-number{color:#9dabc0;font-weight:400}.build-row code{font-size:12px;color:#abc9f0}.download-label{font-size:13px;color:#b2d0ff}.breadcrumbs{display:flex;gap:12px;flex-wrap:wrap}.breadcrumbs a{text-decoration:none}a:focus-visible,button:focus-visible{outline:3px solid #a9caff;outline-offset:3px}@media(max-width:760px){header{flex-wrap:wrap;gap:20px}nav{flex-wrap:wrap}.platforms a{min-height:44px;padding:10px}.app-card,.list-row{padding:20px}.build-row{gap:12px}.download-label{white-space:nowrap}}`
