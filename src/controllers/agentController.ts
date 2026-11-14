import type { AgentCardsApp } from "../createApp.js";
import type { AppRequest } from "../domain/types/RequestTypes.js";
import type { AgentPrincipal } from "../lib/interactors/CardholderInteractor.js";
import { limitOf, sendJson } from "../lib/http/respond.js";
import { requireCheckouts, requireSwaps } from "../lib/utils/requireFeature.js";
import createControllerMethod from "./utils/createControllerMethod.js";

/*
 * Agent REST API (`Authorization: Bearer ak_...`). `authorizeAgent` has set `req.agent`; controllers only
 * read input and call interactors.
 */

const agentOf = (req: AppRequest): AgentPrincipal => req.agent!;

export const getWallet = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await app.cardholders.agentWallet(agentOf(req)));
  });

export const listTransactions = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await app.cardholders.agentTransactions(agentOf(req), limitOf(req.query)));
  });

export const pay = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    const b = req.body;
    sendJson(res, 200, await app.cardholders.pay(agentOf(req), {
      amountCents: b.amountCents as number,
      merchant: b.merchant as string,
      mcc: b.mcc as string | undefined,
      idempotencyKey: b.idempotencyKey as string | undefined,
    }));
  });

export const getCheckout = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireCheckouts(app).getPublic(req.params.checkoutId!));
  });

export const payCheckout = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireCheckouts(app).pay(agentOf(req), req.params.checkoutId!, { maxAmountCents: req.body.maxAmountCents }));
  });

/** Hosted (third-party) checkouts, paid by swapping in the owner's card. */
export const payHostedCheckout = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    const b = req.body;
    sendJson(res, 200, await requireSwaps(app).pay(agentOf(req), {
      checkoutUrl: b.checkoutUrl as string,
      amountCents: b.amountCents as number,
      merchant: b.merchant as string,
      mcc: b.mcc as string | undefined,
      idempotencyKey: b.idempotencyKey as string,
    }));
  });

export const listHostedCheckouts = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireSwaps(app).list(agentOf(req), limitOf(req.query)));
  });

export const getHostedCheckout = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireSwaps(app).get(agentOf(req), req.params.swapId!));
  });

/**
 * Server-sent events: live view (steps and JPEG frames) of this agent's hosted-checkout payments made with Stripe's
 * test card. Sandbox demo only: 404 unless SWAP_STRIPE_TEST_CARD=1.
 */
export const watchHostedCheckouts = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    if (!app.swapLive) return sendJson(res, 404, { error: "live view is only available with SWAP_STRIPE_TEST_CARD=1 (sandbox)" });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": live\n\n");
    const off = app.swapLive.subscribe(agentOf(req).agentId, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    await new Promise<void>((resolve) => req.on("close", () => resolve()));
    clearInterval(ping);
    off();
  });
