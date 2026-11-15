/*
FILE:      src/express.ts
CREATED:   2026-11-16 01:52 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      toExpress(handler): wraps a (Request) => Response handler as an Express/Connect (req, res) handler.
WHY:       Signatures cover the exact raw bytes, so the body must not be parsed first; this reads the raw body (or uses express.raw()) and answers with the handler's status and body.
*/

interface ReqLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  protocol?: string;
  body?: unknown;
  on?: (event: string, cb: (chunk?: Buffer) => void) => unknown;
  readable?: boolean;
}
interface ResLike {
  status(code: number): ResLike;
  setHeader(name: string, value: string): unknown;
  send(body: string): unknown;
}

function readStream(req: ReqLike): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on?.("data", (c) => c && chunks.push(Buffer.from(c)));
    req.on?.("end", () => resolve(Buffer.concat(chunks)));
    req.on?.("error", reject as () => void);
  });
}

export function toExpress(handler: (req: Request) => Promise<Response>) {
  return async function expressHandler(req: ReqLike, res: ResLike): Promise<void> {
    try {
      let raw: Buffer | string;
      if (Buffer.isBuffer(req.body)) raw = req.body;
      else if (typeof req.body === "string") raw = req.body;
      else if (req.body !== undefined && req.body !== null && !(typeof req.body === "object" && Object.keys(req.body).length === 0)) {
        console.error("[kwtsms-auth-relay] body already parsed: mount this route before express.json(), or use express.raw({ type: '*/*' })");
        res.status(500).send("body already parsed");
        return;
      } else raw = await readStream(req);

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      const method = req.method ?? "POST";
      const url = `${req.protocol ?? "https"}://${headers.get("host") ?? "localhost"}${req.originalUrl ?? req.url ?? "/"}`;
      const response = await handler(
        new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : typeof raw === "string" ? raw : new Uint8Array(raw) }),
      );
      res.status(response.status);
      response.headers.forEach((value, name) => res.setHeader(name, value));
      res.send(await response.text());
    } catch {
      res.status(500).send("error");
    }
  };
}
