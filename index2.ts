import { serve } from "bun";
import { $ } from "bun";
import { derivePublicKey, deriveAddress } from 'nanocurrency';

const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BAO Hash Generator</title>
</head>
<body>
    <h1>Enter Data to Hash</h1>
    <form method="POST" action="/">
        <textarea name="data" rows="5" cols="40"></textarea><br>
        <button type="submit">Generate Hash</button>
    </form>
    <div id="result"></div>
</body>
</html>
`;

serve({
  port: 8000,
  async fetch(req) {
    if (req.method === "GET") {
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    if (req.method === "POST") {
        const formData = await req.formData();
        const data = formData.get("data")?.toString() || "";
        
        // Generate BAO hash using external tool
        const process = await $`echo ${data} | bao hash`.text();
        const privateKey = process.trim();  // Ensure we clean the output
        console.log(privateKey);

        try {
          // Derive public key and address using nanocurrency library
          const publicKey = await derivePublicKey(privateKey);
          const address = await deriveAddress(publicKey, { useNanoPrefix: true });
          
          return new Response(
            `<h2>BAO Hash: ${process}<br>Public Key: ${publicKey}<br>Address: ${address}</h2><a href="/">Go Back</a>`,
            { headers: { "Content-Type": "text/html" } }
          );
        } catch (error) {
          console.error("Error deriving keys or address:", error);
          return new Response(
            `<h2>Error generating keys or address. Please try again.</h2><a href="/">Go Back</a>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }
    }

    return new Response("Method Not Allowed", { status: 405 });
  }
});
