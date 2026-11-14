import type { AgentCardsApp } from "../createApp.js";
import { Router } from "../lib/http/Router.js";
import { jsonBody } from "../lib/middleware/bodyParser.js";
import {
  getCheckout, getHostedCheckout, getWallet, listHostedCheckouts, listTransactions, pay, payCheckout, payHostedCheckout, watchHostedCheckouts,
} from "../controllers/agentController.js";

/** Mounted at /agent/v1/ behind `authorizeAgent`. */
export const agentRouter = (app: AgentCardsApp) => {
  const router = new Router();
  router.get("/wallet", getWallet(app));
  router.get("/transactions", listTransactions(app));
  router.post("/pay", jsonBody, pay(app));
  router.get("/checkouts/:checkoutId([A-Za-z0-9_]+)", getCheckout(app));
  router.post("/checkouts/:checkoutId([A-Za-z0-9_]+)/pay", jsonBody, payCheckout(app));
  router.post("/hosted-checkouts/pay", jsonBody, payHostedCheckout(app));
  router.get("/hosted-checkouts", listHostedCheckouts(app));
  router.get("/hosted-checkouts/live", watchHostedCheckouts(app));
  router.get("/hosted-checkouts/:swapId(sw_[a-f0-9]{24})", getHostedCheckout(app));
  return router;
};
