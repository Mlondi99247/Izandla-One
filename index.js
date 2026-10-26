
const ALLOWED_TYPES = [
  "Food order",
  "Cleaning",
  "Ride request"
];

const ALLOWED_STATUSES = [
  "New",
  "Contacted",
  "Confirmed",
  "Completed",
  "Cancelled"
];

const MAX_BODY_BYTES = 20000;

function json(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}

function isAdmin(req) {
  const expected = process.env.IZANDLA_ADMIN_TOKEN;
  const header = req.headers.authorization || "";

  return Boolean(
    expected &&
    header.startsWith("Bearer ") &&
    header.slice(7) === expected
  );
}

function validText(value, max = 1000) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max;
}

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Backend database environment variables are missing");
  }

  return {
    url: url.replace(/\/+$/, ""),
    key
  };
}

async function db(path, options = {}) {
  const config = supabaseConfig();

  const response = await fetch(config.url + "/rest/v1/" + path, {
    method: options.method || "GET",
    headers: {
      "apikey": config.key,
      "Authorization": "Bearer " + config.key,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Prefer": options.prefer || "return=representation"
    },
    body: options.body === undefined
      ? undefined
      : JSON.stringify(options.body)
  });

  const text = await response.text();

  if (!response.ok) {
    console.error("Database request failed:", response.status, text);
    throw new Error("Database operation failed");
  }

  return text ? JSON.parse(text) : [];
}

function cleanRecord(input) {
  const output = {};

  const fields = [
    "name", "address", "pickup", "destination", "phone",
    "service", "store", "items", "payment", "details",
    "date", "passengers", "estimatedKm", "estimatedMinutes"
  ];

  for (const field of fields) {
    const value = input[field];

    if (value === undefined || value === null || value === "") {
      continue;
    }

    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error("Invalid field: " + field);
    }

    const text = String(value);

    if (text.length > 2000) {
      throw new Error("Field too long: " + field);
    }

    output[field] = text;
  }

  return output;
}

module.exports = async function handler(req, res) {
  try {
    const action = String(req.query.action || "");
    const method = req.method;

    // Public: list active participating businesses.
    if (action === "stores" && method === "GET") {
      const stores = await db(
        "stores?select=id,name,type,phone,address,active&active=eq.true&order=name.asc"
      );

      // The public directory deliberately excludes internal fields.
      return json(res, 200, { stores });
    }

    // Public: create a customer service request.
    if (action === "orders" && method === "POST") {
      const size = Number(req.headers["content-length"] || 0);

      if (size > MAX_BODY_BYTES) {
        return json(res, 413, { error: "Request too large" });
      }

      const body = req.body || {};

      if (!ALLOWED_TYPES.includes(body.category)) {
        return json(res, 400, { error: "Invalid request category" });
      }

      const record = cleanRecord(body);

      if (!validText(record.name, 100)) {
        return json(res, 400, { error: "A valid name is required" });
      }

      if (body.category === "Food order") {
        if (!validText(record.store, 150) ||
            !validText(record.items, 1500) ||
            !validText(record.address, 250)) {
          return json(res, 400, {
            error: "Store, food items and delivery address are required"
          });
        }
      }

      if (body.category === "Cleaning" &&
          !validText(record.address, 250)) {
        return json(res, 400, {
          error: "A service address is required"
        });
      }

      if (body.category === "Ride request" &&
          (!validText(record.pickup, 250) ||
           !validText(record.destination, 250))) {
        return json(res, 400, {
          error: "Pickup and destination are required"
        });
      }

      const inserted = await db("orders", {
        method: "POST",
        body: [{
          category: body.category,
          customer_name: record.name,
          customer_phone: record.phone || null,
          details: record
        }]
      });

      const saved = inserted[0];

      return json(res, 201, {
        ok: true,
        order: {
          id: saved.id,
          status: saved.status,
          created_at: saved.created_at
        }
      });
    }

    // All remaining actions require the admin token.
    if (!isAdmin(req)) {
      return json(res, 401, { error: "Admin authentication required" });
    }

    // Admin: view all orders.
    if (action === "orders" && method === "GET") {
      const orders = await db(
        "orders?select=id,category,customer_name,customer_phone,details,status,created_at&order=created_at.desc"
      );

      return json(res, 200, { orders });
    }

    // Admin: change an order status.
    if (action === "orders" && method === "PATCH") {
      const body = req.body || {};
      const id = Number(body.id);

      if (!Number.isSafeInteger(id) || id < 1 ||
          !ALLOWED_STATUSES.includes(body.status)) {
        return json(res, 400, { error: "Invalid order ID or status" });
      }

      const updated = await db(
        "orders?id=eq." + id,
        {
          method: "PATCH",
          body: { status: body.status }
        }
      );

      if (!updated.length) {
        return json(res, 404, { error: "Order not found" });
      }

      return json(res, 200, { ok: true, order: updated[0] });
    }

    // Admin: add a business to the directory.
    if (action === "stores" && method === "POST") {
      const body = req.body || {};

      if (!validText(body.name, 150) ||
          !validText(body.type, 60) ||
          !validText(body.phone, 30)) {
        return json(res, 400, {
          error: "Business name, type and WhatsApp number are required"
        });
      }

      const inserted = await db("stores", {
        method: "POST",
        body: [{
          name: body.name.trim(),
          type: body.type.trim(),
          phone: body.phone.replace(/\D/g, ""),
          address: typeof body.address === "string"
            ? body.address.slice(0, 250)
            : "",
          active: true
        }]
      });

      return json(res, 201, { ok: true, store: inserted[0] });
    }

    // Admin: deactivate a business without deleting its history.
    if (action === "stores" && method === "PATCH") {
      const body = req.body || {};
      const id = Number(body.id);

      if (!Number.isSafeInteger(id) || id < 1 ||
          typeof body.active !== "boolean") {
        return json(res, 400, { error: "Invalid store ID or active value" });
      }

      const updated = await db("stores?id=eq." + id, {
        method: "PATCH",
        body: { active: body.active }
      });

      if (!updated.length) {
        return json(res, 404, { error: "Store not found" });
      }

      return json(res, 200, { ok: true, store: updated[0] });
    }

    res.setHeader("Allow", "GET, POST, PATCH");
    return json(res, 405, { error: "Unsupported method or action" });

  } catch (error) {
    console.error("Izandla API error:", error.message);
    return json(res, 500, {
      error: "The request could not be completed. Check backend configuration."
    });
  }
};
