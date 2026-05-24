const FirecrawlApp = require("@mendable/firecrawl-js").default;
const fs = require("fs");

async function main() {
  const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

  console.log("Scraping https://www.truereligion.com ...");

  const result = await app.scrapeUrl("https://www.truereligion.com/home?lang=default", {
    formats: ["markdown", "html"],
  });

  if (!result.markdown && !result.html) {
    console.error("Scrape returned no content:", JSON.stringify(result, null, 2));
    process.exit(1);
  }

  fs.writeFileSync("scraped-content.md", result.markdown || "");
  fs.writeFileSync("scraped-content.html", result.html || "");

  console.log("Done! Saved:");
  console.log("  - scraped-content.md  (" + (result.markdown || "").length + " chars)");
  console.log("  - scraped-content.html (" + (result.html || "").length + " chars)");
}

main().catch(console.error);
