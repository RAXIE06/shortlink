
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { assetUploadSchema } from "../lib/validators";
import { requireAuth } from "../middleware/auth";

const route = new Hono<AppEnv>();
route.use("*", requireAuth);

// LIST — no saved logos available without R2.
route.get("/", (c) => {
  return c.json({ assets: [] });
});

// UPLOAD — disabled because this deployment does not use R2.
route.post("/", zValidator("json", assetUploadSchema), (c) => {
  return c.json(
    {
      error: "Saved logo uploads are currently unavailable.",
      code: "STORAGE_DISABLED"
    },
    503
  );
});

// SERVE — no stored logo images available.
route.get("/:id", (c) => {
  return c.json({ error: "Not found" }, 404);
});

// DELETE — nothing to delete without R2.
route.delete("/:id", (c) => {
  return c.json({ ok: true });
});

export default route;
