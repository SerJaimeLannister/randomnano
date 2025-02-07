import { serve } from "bun";
import { $ } from "bun";
import * as nanocurrency from 'nanocurrency';
import html from "./public/index.html" with { type: "text" };
import { block } from 'nanocurrency-web';
import { box } from 'nanocurrency-web'

interface AccountInfo {
  frontier: string;
  balance: string;
  representative?: string;
}

// Helper: Generate work using the local nano work server on port 7076
async function getWork(hash: string): Promise<string> {
  const workRequest = {
    action: "work_generate",
    hash: hash,
    difficulty: "fffffff800000000" // adjust difficulty as needed
  };
  const response = await fetch("http://localhost:7076", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workRequest)
  });
  const result = await response.json();
  if (result.error) {
    throw new Error(`Work generation error: ${result.error}`);
  }
  return result.work;
}

async function getAccountInfo(address: string): Promise<AccountInfo> {
  try {
    const response = await fetch('https://app.natrium.io/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'account_info', account: address })
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    
    // If account not found, return default values
    if (data.error === "Account not found") {
      return {
        frontier: "0000000000000000000000000000000000000000000000000000000000000000",
        balance: "0",
        representative: "nano_1xnopayemjmbxnw7e5w769tjs8eyxb7das5mredj4fnutu544ef4pf8n3y4p"
      };
    }

    return {
      frontier: data.frontier,
      balance: data.balance,
      representative: data.representative
    };
  } catch (error) {
    console.error('Error fetching account info:', error);
    throw error;
  }
}

// Helper: Get pending transaction for an account (if any)
async function getPendingTransaction(address: string): Promise<{ hash: string, amount: string }> {
  const response = await fetch('https://app.natrium.io/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'receivable',
      account: address,
      count: "1",
      threshold: "1"
    })
  });
  const result = await response.json();
  console.log("Receivable result:", result);
  if (!result.blocks || Object.keys(result.blocks).length === 0) {
    throw new Error('No pending transactions found');
  }
  // Use the first pending transaction
  const pendingHashes = Object.keys(result.blocks);
  return { hash: pendingHashes[0], amount: result.blocks[pendingHashes[0]] };
}

// Helper: simple delay
async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getLastTransactionTime(fromGuy: string, toGuy: string): Promise<string> {
  try {
    // Fetch account history using Bun.fetch()
    const response = await Bun.fetch("https://app.natrium.io/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "account_history",
        account: fromGuy,
        count: "100"
      })
    });

    // Parse JSON response
    const data = await response.json();
    if (!data.history || data.history.length === 0) {
      throw new Error("No transaction history found.");
    }

    // Loop through history to find a matching "send" transaction
    for (const tx of data.history) {
      if (tx.type === "send" && tx.account === toGuy) {
        if (tx.local_timestamp) {
          return new Date(Number(tx.local_timestamp) * 1000).toLocaleString(); // Convert timestamp to human-readable format
        } else {
          return "Timestamp not available";
        }
      }
    }

    throw new Error("No matching transaction found.");
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

async function receiveFunds(privateKey: string, pendingTx: { hash: string, amount: string }): Promise<{ hash: string, block: any }> {
  const publicKey = await nanocurrency.derivePublicKey(privateKey);
  const accountAddress = await nanocurrency.deriveAddress(publicKey, { useNanoPrefix: true });
  
  // Get current account info; if not opened, assume balance = 0 and genesis frontier.
  let frontier = "0000000000000000000000000000000000000000000000000000000000000000";
  let currentBalance = "0";
  try {
    const info = await getAccountInfo(accountAddress);
    console.log("Account info when receiving:", JSON.stringify(info));
    frontier = info.frontier;
    currentBalance = info.balance;
  } catch (err) {
    console.log("Account not opened yet; assuming balance 0 and using genesis frontier.");
  }
  
  console.log('Current balance:', currentBalance);
  console.log('Pending amount:', pendingTx.amount);
  
  // Ensure we're working with clean string numbers without scientific notation
  const cleanCurrentBalance = BigInt(currentBalance).toString();
  const cleanPendingAmount = BigInt(pendingTx.amount).toString();
  
  // Calculate new balance
  const newBalance = BigInt(cleanCurrentBalance) + BigInt(cleanPendingAmount);
  console.log('New balance:', newBalance.toString());

  const work = await getWork(frontier === "0000000000000000000000000000000000000000000000000000000000000000" ? publicKey : frontier);
  const receiveData = {
    walletBalanceRaw: currentBalance.toString(),
    toAddress: accountAddress,
    // For simplicity, using the account's address as its representative; adjust if needed.
    representativeAddress: accountAddress,
    frontier: frontier,
    transactionHash: pendingTx.hash,
    amountRaw: pendingTx.amount,
    work: work
  };
  const signedBlock = block.receive(receiveData, privateKey);
  console.log("Signed block:", signedBlock);
  const processRequest = {
    action: 'process',
    block: JSON.stringify(signedBlock)
  };
  const response = await fetch('https://app.natrium.io/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(processRequest)
  });
  const result = await response.json();
  if (result.error) {
    throw new Error(`Process error on receive: ${result.error}`);
  }
  return {
    hash: signedBlock.hash,
    block: signedBlock
  };
}

async function transferAllFunds(privateKey: string, destinationAddress: string) {
  try {
    const DEFAULT_REPRESENTATIVE = 'nano_1natrium1o3z5519ifou7xii8crpxpk8y65qmkih8e8bpsjri651oza8imdd';
    const publicKey = await nanocurrency.derivePublicKey(privateKey);
    const senderAddress = await nanocurrency.deriveAddress(publicKey, { useNanoPrefix: true });
    console.log('Sender address:', senderAddress);
    const accountInfo = await getAccountInfo(senderAddress);
    console.log('Account info:', accountInfo);
    const work = await getWork(accountInfo.frontier);
    console.log('Generated work:', work);
    const sendBlockData = {
      walletBalanceRaw: accountInfo.balance,
      fromAddress: senderAddress,
      toAddress: destinationAddress,
      representativeAddress: accountInfo.representative || DEFAULT_REPRESENTATIVE,
      frontier: accountInfo.frontier,
      amountRaw: accountInfo.balance, // sending entire balance
      work: work
    };
    const signedBlock = block.send(sendBlockData, privateKey);
    const processRequest = {
      action: 'process',
      block: JSON.stringify(signedBlock)
    };
    const response = await fetch('https://app.natrium.io/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(processRequest)
    });
    const result = await response.json();
    if (result.error) {
      throw new Error(`Process error: ${result.error}`);
    }
    return {
      hash: signedBlock.hash,
      block: signedBlock,
      senderAddress,
      destinationAddress,
      amount: accountInfo.balance
    };
  } catch (error) {
    console.error('Error in transfer:', error);
    throw error;
  }
}

serve({
  port: 8000,
  async fetch(req) {
    if (req.method === "GET") {
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }
    if (req.method === "POST") {
      const formData = await req.formData();

      // NEW: Check if a concatenated encrypted string is provided.
      const concatenatedString = formData.get("concatenated")?.toString().trim() || "";
      if (concatenatedString) {
        try {
          // Inline definition of extractStrings
          function extractStrings(concatenated: string): { derivedAddress: string; baoHash: string; encrypted: string } {
            const parts = concatenated.split(',');
            if (parts.length !== 3) {
              throw new Error('Invalid concatenated string format');
            }
            return {
              derivedAddress: parts[0],
              baoHash: parts[1],
              encrypted: parts[2]
            };
          }
          const { derivedAddress, baoHash, encrypted } = extractStrings(concatenatedString);

          // Decrypt using the extracted values.
          const decrypted = box.decrypt(encrypted, derivedAddress, baoHash);
          
          // Compute the BAO-derived public address from baoHash.
          const derivedPublicKeyFromBao = await nanocurrency.derivePublicKey(baoHash);
          const derivedAddressFromBao = await nanocurrency.deriveAddress(derivedPublicKeyFromBao, { useNanoPrefix: true });
          
          // Get the time of the last transaction between the BAO-derived address and the original account address.
          const lastTransactionTime = await getLastTransactionTime(derivedAddressFromBao, derivedAddress);
          
          return new Response(
            `<h2>Decrypted Text: ${decrypted}<br>
             Last Transaction Time: ${lastTransactionTime}</h2>
             <a href="/">Go Back</a>`,
            { headers: { "Content-Type": "text/html" } }
          );
        } catch (error) {
          console.error("Error during decryption:", error);
          return new Response(
            `<h2>Error during decryption. Please try again.</h2><a href="/">Go Back</a>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }
      }

      // --- Original branch when concatenated string is not provided ---
      const text = formData.get("text")?.toString() || "";
      const nanoPrivateKey = formData.get("nano_private_key")?.toString() || "";
      
      // Generate BAO hash using an external tool.
      const processOutput = await $`${process.platform === 'win32' ? 'echo' : 'printf'} ${text} | bao hash`.text();
      const baoHash = processOutput.trim();
      console.log("BAO hash (from text):", baoHash);

      try {
        // Derive addresses:
        // - derivedAddress: BAO account (from baoHash).
        // - derivedAddressofnanoPrivatekey: Original account (from nanoPrivateKey).
        const derivedPublicKey = await nanocurrency.derivePublicKey(baoHash);
        const derivedAddress = await nanocurrency.deriveAddress(derivedPublicKey, { useNanoPrefix: true });
        const derivedPublicKeyofnanoPrivatekey = await nanocurrency.derivePublicKey(nanoPrivateKey);
        const derivedAddressofnanoPrivatekey = await nanocurrency.deriveAddress(derivedPublicKeyofnanoPrivatekey, { useNanoPrefix: true });
        console.log("Derived BAO address:", derivedAddress);
        console.log("Original account address:", derivedAddressofnanoPrivatekey);
        const encrypted = box.encrypt(text, derivedAddress, nanoPrivateKey)
        console.log(encrypted)
        // --- First Transfer ---
        // Original account sends funds to BAO account.
        const firstTransferResult = await transferAllFunds(nanoPrivateKey, derivedAddress);
        console.log("First transfer result:", firstTransferResult);
        await delay(5000); // wait for network propagation

        // --- First Receive ---
        // BAO account claims pending funds.
        const pendingTxForBAO = await getPendingTransaction(derivedAddress);
        console.log("Pending transaction for BAO account:", pendingTxForBAO);
        const firstReceiveResult = await receiveFunds(baoHash, pendingTxForBAO);
        console.log("First receive result:", firstReceiveResult);
        await delay(5000); // wait for network propagation

        // --- Second Transfer ---
        // BAO account sends funds back to original account.
        const secondTransferResult = await transferAllFunds(baoHash, derivedAddressofnanoPrivatekey);
        console.log("Second transfer result:", secondTransferResult);
        await delay(5000); // wait for network propagation

        // --- Second Receive ---
        // Original account claims pending funds from second transfer.
        const pendingTxForOriginal = await getPendingTransaction(derivedAddressofnanoPrivatekey);
        console.log("Pending transaction for original account:", pendingTxForOriginal);
        const secondReceiveResult = await receiveFunds(nanoPrivateKey, pendingTxForOriginal);
        console.log("Second receive result:", secondReceiveResult);
        
        // Concatenate the key values into one string.
        function concatenateStrings(derivedAddress: string, baoHash: string, encrypted: string): string {
          return `${derivedAddress},${baoHash},${encrypted}`;
        }
        let concatenated_encrypted_string = concatenateStrings(derivedAddressofnanoPrivatekey, baoHash, encrypted);
        console.log(concatenated_encrypted_string)
        
        
        return new Response(
          `<h2>BAO Hash: ${baoHash}<br>
           Derived BAO Address: ${derivedAddress}<br>
           Original Account Address: ${derivedAddressofnanoPrivatekey}<br>
           First Transfer: ${JSON.stringify(firstTransferResult)}<br>
           First Receive: ${JSON.stringify(firstReceiveResult)}<br>
           Second Transfer: ${JSON.stringify(secondTransferResult)}<br>
           Second Receive: ${JSON.stringify(secondReceiveResult)}</h2>
           <h3>Concatenated Encrypted String:</h3>
           <p>${concatenated_encrypted_string}</p>
           <a href="/">Go Back</a>`,
          { headers: { "Content-Type": "text/html" } }
        );

        // const decrypted = box.decrypt(encrypted, derivedAddressofnanoPrivatekey, baoHash)
      } catch (error) {
        console.error("Error during transfers:", error);
        return new Response(
          `<h2>Error during transfers. Please try again.</h2><a href="/">Go Back</a>`,
          { headers: { "Content-Type": "text/html" } }
        );
      }
    }
    return new Response("Method Not Allowed", { status: 405 });
  }
});
