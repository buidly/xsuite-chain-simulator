import { SContract, SWorld } from 'xsuite';
import { startChainSimulator } from './chainSimulator';
import { CSProxy } from './csproxy';
import { Account, Block } from 'xsuite/dist/proxy/sproxy';
import { KeystoreSigner } from 'xsuite/dist/world/signer';
import path from 'path';
import { Prettify } from 'xsuite/dist/helpers';

let walletCounter = 0;

export class CSWorld extends SWorld {
  proxy: CSProxy;
  sysAcc: SContract;
  verbose: boolean;

  constructor({
    proxy,
    gasPrice,
    explorerUrl,
    verbose,
  }: {
    proxy: CSProxy;
    gasPrice: number;
    explorerUrl?: string;
    verbose?: boolean;
  }) {
    super({ proxy, gasPrice, explorerUrl });
    this.chainId = 'chain';

    this.proxy = proxy;
    this.sysAcc = this.newContract(new Uint8Array(32).fill(255));
    this.verbose = verbose ?? false;
  }

  static new(options: any) {
    if (options.chainId !== undefined) {
      throw new Error('chainId is not undefined.');
    }
    return new CSWorld({
      proxy: new CSProxy(options.proxyUrl, options.autoGenerateBlocks ?? true, options.verbose ?? false),
      gasPrice: options.gasPrice ?? 1000000000,
      explorerUrl: options.explorerUrl,
      verbose: options.verbose,
    });
  }

  static async start({
    port,
    gasPrice,
    explorerUrl,
    autoGenerateBlocks,
    verbose,
  }: {
    port?: number;
    gasPrice?: number;
    explorerUrl?: string;
    autoGenerateBlocks?: boolean,
    verbose?: boolean
  } = {}): Promise<CSWorld> {
    const proxyUrl = await startChainSimulator(port);
    return CSWorld.new({ proxyUrl, gasPrice, explorerUrl, autoGenerateBlocks, verbose });
  }

  async createWallet(params: Prettify<Omit<Account, 'address'>> = {}) {
    walletCounter += 1;

    // Even though the signature is not checked for chain simulator, we still seem to need real address format for the chain validator
    const keystore = await KeystoreSigner.fromFile_unsafe(path.join(__dirname, 'wallet.json'), '', walletCounter);
    const wallet = this.newWallet(keystore);
    await wallet.setAccount(params);
    return wallet;
  }

  setCurrentBlockInfo(block: Block) {
    throw new Error('Not implemented');
  }

  generateBlocks(numBlocks: number = 1) {
    return this.proxy.generateBlocks(numBlocks);
  }

  getInitialWallets() {
    return this.proxy.getInitialWallets();
  }
}
