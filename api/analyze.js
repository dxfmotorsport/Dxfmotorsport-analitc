import Anthropic from "@anthropic-ai/sdk";

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function fetchShopifyData(endpoint) {
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2026-04/${endpoint}`,
    {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_TOKEN,
        "Content-Type": "application/json",
      },
    }
  );
  if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);
  return res.json();
}

async function gatherStoreData() {
  const [productsData, ordersData, customersData] = await Promise.all([
    fetchShopifyData("products.json?limit=50&fields=id,title,body_html,images,variants,status,tags,product_type"),
    fetchShopifyData("orders.json?limit=50&status=any&fields=id,total_price,line_items,created_at,financial_status,fulfillment_status,customer"),
    fetchShopifyData("customers.json?limit=50&fields=id,created_at,orders_count,total_spent,tags"),
  ]);

  const products = productsData.products || [];
  const orders = ordersData.orders || [];
  const customers = customersData.customers || [];

  const totalRevenue = orders
    .filter((o) => o.financial_status === "paid")
    .reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);

  const productSales = {};
  orders.forEach((order) => {
    (order.line_items || []).forEach((item) => {
      productSales[item.title] = (productSales[item.title] || 0) + item.quantity;
    });
  });

  const topProducts = Object.entries(productSales)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const productsWithoutImages = products.filter((p) => !p.images || p.images.length === 0);
  const productsWithoutDescription = products.filter(
    (p) => !p.body_html || p.body_html.replace(/<[^>]*>/g, "").trim().length < 50
  );
  const draftProducts = products.filter((p) => p.status === "draft");

  const newCustomers = customers.filter((c) => c.orders_count === 1).length;
  const returningCustomers = customers.filter((c) => c.orders_count > 1).length;

  return {
    summary: {
      totalProducts: products.length,
      totalOrders: orders.length,
      totalCustomers: customers.length,
      totalRevenue: totalRevenue.toFixed(2),
      newCustomers,
      returningCustomers,
    },
    issues: {
      productsWithoutImages: productsWithoutImages.map((p) => p.title),
      productsWithoutDescription: productsWithoutDescription.map((p) => p.title),
      draftProducts: draftProducts.map((p) => p.title),
    },
    topProducts,
    products: products.map((p) => ({
      title: p.title,
      status: p.status,
      type: p.product_type,
      tags: p.tags,
      hasImages: p.images && p.images.length > 0,
      hasDescription: p.body_html && p.body_html.replace(/<[^>]*>/g, "").trim().length > 50,
      variants: p.variants?.length || 0,
      price: p.variants?.[0]?.price || "0",
    })),
    recentOrders: orders.slice(0, 10).map((o) => ({
      total: o.total_price,
      items: o.line_items?.map((i) => i.title),
      date: o.created_at,
      status: o.financial_status,
    })),
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const storeData = await gatherStoreData();

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const prompt = `Eres un experto en ecommerce y marketing digital especializado en tiendas de motorsport y mecanizado de precisión.
Analiza los datos de la tienda DXFMotorsport (taller de mecanizado CNC, impresión 3D y fabricación para el sector motorsport, con base en Narón, Galicia, con envíos a toda Europa).

DATOS DE LA TIENDA:
${JSON.stringify(storeData, null, 2)}

Genera un informe detallado en español con estas secciones:

## 🏁 RESUMEN EJECUTIVO
Un párrafo con el estado general de la tienda.

## 🔴 PROBLEMAS CRÍTICOS
Lista de problemas que están frenando ventas ahora mismo, con solución concreta para cada uno.

## 📦 ANÁLISIS DE CATÁLOGO
- Productos con ficha incompleta (sin imágenes, sin descripción)
- Productos en borrador que podrían publicarse
- Sugerencias de mejora para las fichas de producto más importantes

## 📈 OPORTUNIDADES DE CONVERSIÓN
Acciones concretas para mejorar la tasa de conversión basadas en los datos.

## 🎯 CAPTACIÓN DE CLIENTES
Estrategias específicas para DXFMotorsport para atraer más clientes del sector motorsport europeo.

## 💡 RECOMENDACIONES PRIORITARIAS
Top 5 acciones ordenadas por impacto potencial, con estimación de esfuerzo (bajo/medio/alto).

Sé específico, directo y práctico. Evita generalidades. Cada recomendación debe ser accionable hoy mismo.`;

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });

    const analysis = message.content[0].text;

    return res.status(200).json({
      success: true,
      storeData,
      analysis,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
