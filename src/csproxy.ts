import { Proxy, SProxy } from 'xsuite';
import { Account, Block } from 'xsuite/dist/proxy/sproxy';
import { addressToBech32 } from 'xsuite/dist/data/address';
import { codeMetadataToHex } from 'xsuite/dist/proxy/proxy';
import { kvsToRawKvs } from 'xsuite/dist/data/kvs';

export class CSProxy extends SProxy {
  autoGenerateBlocks: boolean;
  verbose: boolean;

  constructor(baseUrl: string, autoGenerateBlocks: boolean = true, verbose: boolean = false) {
    super(baseUrl);

    this.autoGenerateBlocks = autoGenerateBlocks;
    this.verbose = verbose;
  }

  async sendTx(tx: any): Promise<string> {
    // The chain simulator needs signature to not be empty
    // TODO: Alternatively edit the DummySigner to return this instead of an empty string
    if (!tx.signature) {
      tx.signature = '00';
    }

    if (this.verbose) {
      console.log('Sending transaction', tx);
    }

    const result = super.sendTx(tx);

    if (this.autoGenerateBlocks) {
      await result;

      await this.generateBlocks();
    }

    return result;
  }

  static async getCompletedTxRaw(baseUrl: string, txHash: string, verbose: boolean) {
    let res = await Proxy.getTxProcessStatusRaw(baseUrl, txHash);

    if (verbose) {
      console.log('pending: tx hash', txHash, 'response', res);
    }

    let retries = 0;

    while (!res || res.code !== "successful" || res.data.status === "pending") {
      await new Promise((r) => setTimeout(r, 250));

      if (res && res.data && res.data.status === "pending") {
        if (verbose) {
          console.log('Generating 1 block...');
        }

        await CSProxy.generateBlocks(baseUrl);
      }

      res = await CSProxy.getTxProcessStatusRaw(baseUrl, txHash);

      if (verbose) {
        console.log('pending: tx hash', txHash, 'response', res);
      }

      retries++;

      // Prevent too many retries in case something does not work as expected
      if (retries > 10) {
        break;
      }
    }

    return await CSProxy.getTxRaw(baseUrl, txHash, { withResults: true });
  }

  static async getCompletedTx(baseUrl: string, txHash: string, verbose: boolean) {
    return unrawTxRes(await CSProxy.getCompletedTxRaw(baseUrl, txHash, verbose));
  }

  async getCompletedTx(txHash: string) {
    if (this.verbose) {
      console.log('Get completed tx', txHash);
    }

    return CSProxy.getCompletedTx(this.baseUrl, txHash, this.verbose);
  }

  static async setAccount(baseUrl: string, account: Account, autoGenerateBlocks: boolean = true, verbose: boolean = false) {
    if (verbose) {
      console.log('Setting account', [accountToRawAccount(account)]);
    }

    const result = Proxy.fetch(
      `${baseUrl}/simulator/set-state`,
      [accountToRawAccount(account)],
    );

    if (autoGenerateBlocks) {
      await result;

      await CSProxy.generateBlocks(baseUrl);
    }

    return result;
  }

  setAccount(account: Account) {
    return CSProxy.setAccount(this.baseUrl, account, this.autoGenerateBlocks, this.verbose);
  }

  static setCurrentBlock(baseUrl: string, block: Block) {
    throw new Error('Not implemented');
  }

  setCurrentBlock(block: Block) {
    throw new Error('Not implemented');
  }

  static terminate(baseUrl: string) {
    // Nothing to do here currently
  }

  terminate() {
    return CSProxy.terminate(this.baseUrl);
  }

  static generateBlocks(baseUrl: string, numBlocks: number = 1) {
    return Proxy.fetch(`${baseUrl}/simulator/generate-blocks/${numBlocks}`, {});
  }

  generateBlocks(numBlocks: number = 1) {
    return CSProxy.generateBlocks(this.baseUrl, numBlocks);
  }

  static getInitialWallets(baseUrl: string) {
    return Proxy.fetch(`${baseUrl}/simulator/initial-wallets`);
  }

  getInitialWallets() {
    return CSProxy.getInitialWallets(this.baseUrl);
  }
}

const accountToRawAccount = (account: Account) => {
  return {
    address: addressToBech32(account.address),
    nonce: account.nonce,
    balance: account.balance?.toString() || '0',
    keys: account.kvs != null ? kvsToRawKvs(account.kvs) : undefined,
    code: account.code,
    codeMetadata:
      account.codeMetadata != null
        ? codeMetadataToHex(account.codeMetadata)
        : undefined,
    ownerAddress: account.owner != null ? addressToBech32(account.owner) : undefined,
    developerReward: '0',
  };
};


const unrawRes = (res: any) => {
  if (res.code === "successful") {
    return res.data;
  } else {
    const resStr = JSON.stringify(res, null, 2);
    throw new Error(`Unsuccessful proxy request. Response: ${resStr}`);
  }
};

const unrawTxRes = (r: any) => {
  return unrawRes(r).transaction as Record<string, any>;
};
