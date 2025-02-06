import { serve } from "bun";
import { $ } from "bun";
import * as nanocurrency from 'nanocurrency';
import html from "./public/index.html" with { type: "text" };
import { block } from 'nanocurrency-web';

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
      action: 'pending',
      account: address,
      threshold: "1"
    })
  });
  const result = await response.json();
  if (!result.pending || Object.keys(result.pending).length === 0) {
    throw new Error('No pending transactions found');
  }
  // Use the first pending transaction
  const pendingHashes = Object.keys(result.pending);
  return { hash: pendingHashes[0], amount: result.pending[pendingHashes[0]] };
}

// Helper: simple delay
async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: Create and process a receive block to claim pending funds.
// The new balance is computed as currentBalance + pendingAmount.
async function receiveFunds(privateKey: string, pendingTx: { hash: string, amount: string }): Promise<{ hash: string, block: any }> {
  const publicKey = await nanocurrency.derivePublicKey(privateKey);
  const accountAddress = await nanocurrency.deriveAddress(publicKey, { useNanoPrefix: true });
  
  // Get current account info; if not opened, assume balance = 0 and genesis frontier.
  let frontier = "0000000000000000000000000000000000000000000000000000000000000000";
  let currentBalance = "0";
  try {
    const info = await getAccountInfo(accountAddress);
    frontier = info.frontier;
    currentBalance = info.balance;
  } catch (err) {
    console.log("Account not opened yet; assuming balance 0 and using genesis frontier.");
  }
  
  // Calculate new balance as currentBalance + pending amount (using BigInt arithmetic)
  const newBalance = (BigInt(currentBalance) + BigInt(pendingTx.amount)).toString();

  const work = await getWork(frontier);
  const receiveData = {
    walletBalanceRaw: newBalance,
    toAddress: accountAddress,
    // For simplicity, using the account's address as its representative; adjust if needed.
    representativeAddress: accountAddress,
    frontier: frontier,
    transactionHash: pendingTx.hash,
    amountRaw: pendingTx.amount,
    work: work
  };
  const signedBlock = block.receive(receiveData, privateKey);
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

// Helper: Transfer all funds from the account (derived from privateKey) to destinationAddress.
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
      const text = formData.get("text")?.toString() || "";
      // nanoPrivateKey provided via the form is the original account's private key.
      const nanoPrivateKey = formData.get("nano_private_key")?.toString() || "";
      
      // Generate BAO hash using an external tool.
      const processOutput = await $`echo ${text} | bao hash`.text();
      const baoHash = processOutput.trim();
      console.log("BAO hash (from text):", baoHash);

      try {
        // Derive addresses:
        // - derivedAddress: BAO account (from baoHash).
        // - derivedAddressofnanoPrivatekey: Original account (from nanoPrivateKey).
        const derivedPublicKey = await nanocurrency.derivePublicKey(baoHash);
        const derivedAddress = await nanocurrency.deriveAddress(derivedPublicKey, { useNanoPrefix: true });
        const derivedAddressofnanoPrivatekey = await nanocurrency.deriveAddress(nanoPrivateKey, { useNanoPrefix: true });
        console.log("Derived BAO address:", derivedAddress);
        console.log("Original account address:", derivedAddressofnanoPrivatekey);

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

        return new Response(
          `<h2>BAO Hash: ${baoHash}<br>
           Derived BAO Address: ${derivedAddress}<br>
           Original Account Address: ${derivedAddressofnanoPrivatekey}<br>
           First Transfer: ${JSON.stringify(firstTransferResult)}<br>
           First Receive: ${JSON.stringify(firstReceiveResult)}<br>
           Second Transfer: ${JSON.stringify(secondTransferResult)}<br>
           Second Receive: ${JSON.stringify(secondReceiveResult)}</h2>
           <a href="/">Go Back</a>`,
          { headers: { "Content-Type": "text/html" } }
        );
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
