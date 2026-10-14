// node tests/bdd/shot.mjs "<path?query>" out.png [waitMs] [evalExpression]
import { startServer, launch } from "./harness.mjs";

const [path = "?smoke", out = "test-artifacts/shot.png", wait = "8000", expr] = process.argv.slice(2);
const server = await startServer();
const { browser, page, logs } = await launch();
try {
    await page.goto(server.url + path);
    await page.waitForTimeout(Number(wait));
    if (expr) console.log("eval:", JSON.stringify(await page.evaluate(expr), null, 1)?.slice(0, 4000));
    await page.screenshot({ path: out });
    console.log("saved", out);
} finally {
    console.log(logs.slice(-40).join("\n"));
    await browser.close();
    await server.close();
}
