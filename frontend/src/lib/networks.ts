import document from '@protocol-manifest';
import { parseNetworks, transactionUrl } from '../../../config/schema.mjs';

export const networks = parseNetworks(document);
export const explorerTransactionUrl = (chainId: number, hash?: string) =>
  transactionUrl(networks, chainId, hash);
