import type { AgentCardsApp } from "../createApp.js";
import { unauthorizedError } from "../errors.js";
import { sendJson } from "../lib/http/respond.js";
import { CircleError } from "../lib/clients/circle/CircleClient.js";
import { requireCircleDeposits } from "../lib/utils/requireFeature.js";
import createControllerMethod from "./utils/createControllerMethod.js";

const header = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * Circle deposit webhooks: signed by Circle, verified over the raw body (the `rawBody` middleware).
 * A non-2xx makes Circle retry, so only a bad signature is a 4xx; anything else we could not finish is a 500.
 */
export const circleWebhook = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    const circle = requireCircleDeposits(app);
    try {
      const r = await circle.handle(req.rawBody, { signature: header(req.headers["x-circle-signature"]), keyId: header(req.headers["x-circle-key-id"]) });
      if (r.status === "ignored" && !/^type /.test(r.reason)) app.log?.(`circle webhook ignored: ${r.reason}`);
      await app.alerts?.clear("circle-webhook", "Circle webhook handled a delivery again.");
      sendJson(res, 200, { ok: true, status: r.status });
    } catch (e) {
      if (e instanceof CircleError && e.status === 401) {
        app.log?.(`circle webhook refused: ${e.message}`);
        throw unauthorizedError("invalid signature");
      }
      // Anything but a bad signature is ours (Circle API down, ledger error): Circle will retry, and a person should know.
      await app.alerts?.raise("circle-webhook", `Circle webhook failed (Circle will retry): ${(e as Error).message}`);
      throw e;
    }
  });
