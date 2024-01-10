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

  constructor({
    proxy,
    gasPrice,
    explorerUrl,
  }: {
    proxy: CSProxy;
    gasPrice: number;
    explorerUrl?: string;
  }) {
    super({ proxy, gasPrice, explorerUrl });
    this.chainId = "chain";

    this.proxy = proxy;
    this.sysAcc = this.newContract(new Uint8Array(32).fill(255));
  }

  static new(options: any) {
    if (options.chainId !== undefined) {
      throw new Error('chainId is not undefined.');
    }
    return new CSWorld({
      proxy: new CSProxy(options.proxyUrl, options.autoGenerateBlocks ?? true),
      gasPrice: options.gasPrice ?? 1000000000,
      explorerUrl: options.explorerUrl,
    });
  }

  static async start({
    port,
    gasPrice,
    explorerUrl,
    autoGenerateBlocks,
  }: { port?: number; gasPrice?: number; explorerUrl?: string; autoGenerateBlocks?: boolean } = {}): Promise<CSWorld> {
    const proxyUrl = await startChainSimulator(port);
    return CSWorld.new({ proxyUrl, gasPrice, explorerUrl, autoGenerateBlocks });
  }

  async createWallet(params: Prettify<Omit<Account, 'address'>> = {}) {
    walletCounter += 1;

    console.log('loading keystore');
    // TODO: Seems that signature is not checked for chain simulator, so this won't be needed
    const keystore = await KeystoreSigner.fromFile_unsafe(path.join(__dirname, 'wallet.json'), '', walletCounter);
    console.log('keystore loaded');
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
