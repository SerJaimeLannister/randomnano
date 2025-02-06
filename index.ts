import { derivePublicKey, deriveAddress } from 'nanocurrency';

const privateKey = 'dc5a4edb8240b018124052c330270696f96771a63b45250a5c17d3000e823355';

const publicKey = derivePublicKey(privateKey);
const address = deriveAddress(publicKey, { useNanoPrefix: true });

console.log({ privateKey, publicKey, address });
