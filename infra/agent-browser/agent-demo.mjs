/**
 * Minimal "agent with its own browser, that you can watch".
 *
 * 1. asks Steel for an isolated browser session
 * 2. opens a tab in it and attaches a viewer to *that* tab's screencast,
 *    so we can prove frames are actually flowing
 * 3. drives the browser over CDP (any Playwright/Puppeteer code goes here)
 * 4. releases the session
 *
 * Run:  npm install && npm start
 *       DEMO_URL=https://example.com npm start
 */
import puppeteer from "puppeteer-core";
import WebSocket from "ws";

const API = process.env.STEEL_API ?? "http://localhost:3000";
const VIEWER = process.env.STEEL_VIEWER ?? "http://localhost:5173";
// Pick a target the container can actually reach. With BROWSER_PROXY empty that is
// direct egress: domestic sites are fine, blocked ones need the proxy enabled.
const TARGET = process.env.DEMO_URL ?? "https://juejin.cn";

const wsBase = API.replace(/^http/, "ws");
const post = (path, body) =>
  fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// 1. one isolated browser for this agent/task
const session = await (
  await post("/v1/sessions", { dimensions: { width: 1280, height: 800 }, blockAds: true })
).json();

console.log(`session   : ${session.id}`);
console.log(`watch live: ${VIEWER}/sessions/${session.id}\n`);

// 2. the agent gets a tab in that session
const browser = await puppeteer.connect({
  browserWSEndpoint: session.websocketUrl,
  defaultViewport: null,
});
const page = await browser.newPage();
const pageId = page.target()._targetId; // the tab the viewer must follow
console.log(`agent opened tab ${pageId.slice(0, 8)} in the session`);

// 2b. subscribe to the same screencast the viewer uses. Each message is a JSON
//     text frame: {pageId,url,title,favicon,data:<base64 jpeg>}.
//     pageId is what makes the stream follow the agent's tab; without it the
//     screencast attaches to another tab and you end up watching a blank page.
const cast = new WebSocket(`${wsBase}/v1/sessions/cast?sessionId=${session.id}&pageId=${pageId}`);
let frames = 0;
let bytes = 0;
cast.on("message", (m) => {
  frames += 1; // one message == one screencast frame (base64 JPEG + page metadata)
  bytes += m.length;
});
await new Promise((res, rej) => {
  cast.on("open", res);
  cast.on("error", rej);
});

// 3. drive it
await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 45000 });
console.log(`agent navigated to: ${page.url()} | ${await page.title()}`);

for (let i = 0; i < 12; i++) {
  await page.evaluate(() => window.scrollBy({ top: 260, behavior: "smooth" }));
  await new Promise((r) => setTimeout(r, 600));
}

console.log(
  `\nviewer received ${frames} frames / ${(bytes / 1024).toFixed(1)} KB while the agent worked`,
);
console.log(`page title the agent sees: ${await page.title()}`);

// 4. clean up — a session keeps a browser alive until released
await browser.disconnect();
cast.close();
await post(`/v1/sessions/${session.id}/release`);
console.log("session released");
