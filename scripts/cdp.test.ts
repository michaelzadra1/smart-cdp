import { expect, test } from "bun:test";
import { connect } from "./cdp";

test("a new tab opens in the background unless the caller asks otherwise", async () => {
  const sent: unknown[] = [];
  using server = Bun.serve({
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request) ? undefined : new Response(null, { status: 400 }),
    websocket: {
      message(socket, data) {
        const { id, params } = JSON.parse(String(data));
        sent.push(params);
        socket.send(JSON.stringify({ id, result: { targetId: "t" } }));
      },
    },
  });
  const cdp = await connect(`ws://127.0.0.1:${server.port}`);
  try {
    await cdp.Target.createTarget({ url: "about:blank" });
    await cdp.Target.createTarget({ url: "about:blank", background: false });
  } finally {
    await cdp.close();
  }
  expect(sent).toEqual([
    { background: true, url: "about:blank" },
    { background: false, url: "about:blank" },
  ]);
});
