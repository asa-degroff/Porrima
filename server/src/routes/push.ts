import { Router } from "express";
import {
  deleteSubscriptionByDeviceId,
  getSubscriptionsForUser,
  getVapidKeys,
  markPresence,
  upsertSubscription,
} from "../services/push-storage.js";
import { sendPush } from "../services/push-dispatch.js";

const router = Router();

const OWNER_ID = "owner";

// GET /api/push/public-key — returns the urlBase64 VAPID public key for the SW
// to subscribe with. Cheap, called once on first enable.
router.get("/public-key", async (_req, res) => {
  try {
    const keys = await getVapidKeys();
    res.json({ key: keys.publicKey });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to load VAPID keys" });
  }
});

// POST /api/push/subscribe { deviceId, subscription, userAgent?, label? }
router.post("/subscribe", async (req, res) => {
  const { deviceId, subscription, userAgent, label } = req.body ?? {};
  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "deviceId required" });
  }
  if (
    !subscription?.endpoint ||
    !subscription?.keys?.p256dh ||
    !subscription?.keys?.auth
  ) {
    return res.status(400).json({ error: "invalid subscription" });
  }
  try {
    upsertSubscription({
      deviceId,
      userId: OWNER_ID,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: typeof userAgent === "string" ? userAgent : null,
      label: typeof label === "string" ? label : null,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to save subscription" });
  }
});

// POST /api/push/unsubscribe { deviceId }
router.post("/unsubscribe", (req, res) => {
  const { deviceId } = req.body ?? {};
  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "deviceId required" });
  }
  deleteSubscriptionByDeviceId(deviceId);
  res.json({ ok: true });
});

// POST /api/push/presence { deviceId, visible: boolean }
router.post("/presence", (req, res) => {
  const { deviceId, visible } = req.body ?? {};
  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "deviceId required" });
  }
  if (visible) markPresence(deviceId, "ping");
  // visible:false leaves the entry in place — it will expire naturally on its
  // own 30s window. (Suddenly clearing on tab-hide creates a race where a
  // notification fires moments before the device truly backgrounds.)
  res.json({ ok: true });
});

// GET /api/push/devices — list registered devices for the settings UI
router.get("/devices", (_req, res) => {
  const subs = getSubscriptionsForUser(OWNER_ID).map((row) => ({
    deviceId: row.deviceId,
    userAgent: row.userAgent,
    label: row.label,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  }));
  res.json({ devices: subs });
});

// POST /api/push/test — send a test notification to all of the user's devices,
// bypassing presence. Used by the settings UI to verify the path end-to-end.
router.post("/test", async (_req, res) => {
  try {
    const result = await sendPush(
      OWNER_ID,
      {
        type: "test",
        title: "Porrima",
        body: "Push notifications are working.",
        url: "/",
        tag: "push-test",
      },
      { ignorePresence: true }
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to send test push" });
  }
});

export default router;
