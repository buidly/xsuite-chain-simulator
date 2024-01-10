import { afterEach, beforeEach, test } from 'vitest';
import { assertAccount, e, Proxy, SContract, SWallet } from 'xsuite';
import { mainnetPublicProxyUrl } from 'xsuite/dist/interact/envChain';
import { CSWorld } from '../src/csworld';
import { DummySigner, UserSigner } from 'xsuite/dist/world/signer';
import { UserSecretKey, UserSigner as BaseUserSigner } from '@multiversx/sdk-wallet/out';
import path from 'path';
import { promises } from 'fs';

const SYSTEM_DELEGATION_MANAGER_ADDRESS = 'erd1qqqqqqqqqqqqqqqpqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqylllslmq6y6';

const LIQUID_STAKING_CONTRACT_ADDRESS = 'erd1qqqqqqqqqqqqqpgq4gzfcw7kmkjy8zsf04ce6dl0auhtzjx078sslvrf4e';

let realContract: any;

let world: CSWorld;
let deployer: SWallet;
let address: SWallet;

let systemDelegationContract: SContract;
let contract: SContract;

beforeEach(async () => {
  realContract = await Proxy.getSerializableAccountWithKvs(mainnetPublicProxyUrl, LIQUID_STAKING_CONTRACT_ADDRESS);
  world = await CSWorld.start();
  deployer = await world.createWallet();
  address = await world.createWallet({
    balance: '1255000000000000000000', // 1255 EGLD
  });

  await world.setAccount({
    ...realContract,
    owner: deployer,
  });

  systemDelegationContract = world.newContract(SYSTEM_DELEGATION_MANAGER_ADDRESS);
  contract = world.newContract(LIQUID_STAKING_CONTRACT_ADDRESS);
});

afterEach(async () => {
  // await new Promise((resolve, reject) => {
  //   setTimeout(() => resolve(), 60_000);
  // });

  await world.terminate();
}, 60_000);

test('Test', async () => {
  // generate 20 blocks to pass an epoch and the smart contract deploys to be enabled
  await world.generateBlocks(20);

  let tx = await address.callContract({
    callee: systemDelegationContract,
    funcName: 'createNewDelegationContract',
    gasLimit: 65_000_000,
    value: '1250000000000000000000', // 1250 EGLD
    funcArgs: [
      e.U(0), // delegation cap
      e.U16(3745), // service fee
    ],
  });

  console.log('Transaction create new delegation contract', tx);

  const stakingProviderContract = extractContract(tx);

  console.log('Staking Provider', stakingProviderContract);

  const initialWallets = await world.getInitialWallets();
  const initialAddressWithStake = initialWallets.initialWalletWithStake.address;
  const initialAddressPrivateKey = initialWallets.initialWalletWithStake.privateKeyHex;

  console.log('Initial address with stake', initialAddressWithStake);
  console.log('Initial address private key', initialAddressPrivateKey);

  tx = await address.callContract({
    callee: stakingProviderContract,
    funcName: 'whitelistForMerge',
    gasLimit: 65_000_000,
    funcArgs: [
      e.Addr(initialAddressWithStake),
    ],
  });

  console.log('Transaction whitelist for merge', tx);

  const userSecretKey = UserSecretKey.fromPem(await promises.readFile(
    path.join(__dirname, 'validator.pem'),
    { encoding: 'utf8' },
  ));
  const baseUserSigner = new BaseUserSigner(userSecretKey);

  // @ts-ignore
  const initialWalletSigner = world.newWallet(new UserSigner(baseUserSigner));

  console.log('Initial wallet', initialWalletSigner);

  const initialAddressWithStakeWallet = world.newWallet(new DummySigner(initialAddressWithStake));

  tx = await initialAddressWithStakeWallet.callContract({
    callee: systemDelegationContract,
    funcName: 'mergeValidatorToDelegationWithWhitelist',
    gasLimit: 510_000_000,
    funcArgs: [
      stakingProviderContract,
    ],
  });

  console.log('Transaction merge validator', tx);

  // generate 20 blocks to pass an epoch and some rewards will be distributed
  await world.generateBlocks(20);

  await address.callContract({
    callee: stakingProviderContract,
    funcName: 'claimRewards',
    gasLimit: 510_000_000,
  });

  assertAccount(await address.getAccountWithKvs(), {
    balance: '8455541737203123588', // 5 EGLD remaining initially - fees + rewards
  });

  // assertAccount(await contract.getAccountWithKvs(), {
  //   hasKvs: [],
  // });
}, { timeout: 60_000 });

const extractContract = (tx): SContract => {
  const events = tx.tx.logs.events;

  for (const event: any of events) {
    if (event.identifier !== 'SCDeploy') {
      continue;
    }

    const address = Buffer.from(event.topics[0], 'base64');

    return world.newContract(address);
  }
};
