import { afterEach, assert, beforeEach, test } from 'vitest';
import { assertAccount, d, e, Proxy, SContract, SWallet } from 'xsuite';
import { mainnetPublicProxyUrl } from 'xsuite/dist/interact/envChain';
import { CSWorld } from '../src/csworld';
import { DummySigner, UserSigner } from 'xsuite/dist/world/signer';
import { UserSecretKey, UserSigner as BaseUserSigner } from '@multiversx/sdk-wallet/out';
import path from 'path';
import { promises } from 'fs';

const SYSTEM_DELEGATION_MANAGER_ADDRESS = 'erd1qqqqqqqqqqqqqqqpqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqylllslmq6y6';

const LIQUID_STAKING_CONTRACT_ADDRESS = 'erd1qqqqqqqqqqqqqpgq4gzfcw7kmkjy8zsf04ce6dl0auhtzjx078sslvrf4e';
const ADMIN_ADDRESS = 'erd1cc2yw3reulhshp3x73q2wye0pq8f4a3xz3pt7xj79phv9wm978ssu99pvt';

let world: CSWorld;
let deployer: SWallet;
let address: SWallet;
let alice: SWallet;
let bob: SWallet;
let admin: SWallet;

let systemDelegationContract: SContract;
let liquidStakingContract: SContract;

beforeEach(async () => {
  const realContract = await Proxy.getSerializableAccountWithKvs(
    mainnetPublicProxyUrl,
    LIQUID_STAKING_CONTRACT_ADDRESS,
  );
  world = await CSWorld.start();

  // Wallets always need EGLD balance to pay for fees
  deployer = await world.createWallet({
    balance: '1000000000000000000', // 1 EGLD
  });
  address = await world.createWallet({
    balance: '1255000000000000000000', // 1255 EGLD
  });
  alice = await world.createWallet({
    balance: '50000000000000000000', // 50 EGLD
  });
  bob = await world.createWallet({
    balance: '10000000000000000000', // 10 EGLD
  });
  admin = await world.newWallet(new DummySigner(ADMIN_ADDRESS));
  await admin.setAccount({
    balance: '10000000000000000000', // 10 EGLD
  });

  await world.setAccount({
    ...realContract,
    owner: deployer,
  });

  systemDelegationContract = world.newContract(SYSTEM_DELEGATION_MANAGER_ADDRESS);
  liquidStakingContract = world.newContract(LIQUID_STAKING_CONTRACT_ADDRESS);
});

afterEach(async () => {
  // Having this here so we can access the chain simulator endpoints outside of tests
  // await new Promise((resolve, reject) => {
  //   setTimeout(() => resolve(), 60_000);
  // });

  await world.terminate();
}, 60_000);

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

const deployDelegationProvider = async () => {
  let tx = await address.callContract({
    callee: systemDelegationContract,
    funcName: 'createNewDelegationContract',
    gasLimit: 65_000_000,
    value: '1250000000000000000000', // 1250 EGLD
    funcArgs: [
      e.U(0), // delegation cap
      e.U(3745), // service fee
    ],
  });

  console.log('Transaction create new delegation contract', tx);

  const stakingProviderDelegationContract = extractContract(tx);

  console.log('Staking Provider', stakingProviderDelegationContract);

  const initialWallets = await world.getInitialWallets();
  const initialAddressWithStake = initialWallets.initialWalletWithStake.address;
  const initialAddressPrivateKey = initialWallets.initialWalletWithStake.privateKeyHex;

  console.log('Initial address with stake', initialAddressWithStake);
  console.log('Initial address private key', initialAddressPrivateKey);

  tx = await address.callContract({
    callee: stakingProviderDelegationContract,
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
      stakingProviderDelegationContract,
    ],
  });

  console.log('Transaction merge validator', tx);

  // generate 20 blocks to pass an epoch and some rewards will be distributed
  await world.generateBlocks(20);

  await address.callContract({
    callee: stakingProviderDelegationContract,
    funcName: 'claimRewards',
    gasLimit: 510_000_000,
  });

  // This fails sometimes randomly because of wrong egld balance...
  // Probably because too many blocks pass when processing pending transactions on different test runs
  // assertAccount(await address.getAccountWithKvs(), {
  //   balance: '11918555165970247194', // 5 EGLD remaining initially - fees + rewards
  // });

  return { stakingProviderDelegationContract };
};

const setupLiquidStaking = async (stakingProviderDelegationContract: SContract) => {
  let result = await world.query({
    callee: stakingProviderDelegationContract,
    funcName: 'getTotalActiveStake',
  });

  const stakingProviderStake = d.U().topDecode(result.returnData[0]);

  console.log('Staking provider stake: ', stakingProviderStake);

  assert(stakingProviderStake === 11250000000000000000000n);

  await admin.callContract({
    callee: liquidStakingContract,
    funcName: 'whitelistDelegationContract',
    gasLimit: 510_000_000,
    funcArgs: [
      stakingProviderDelegationContract,
      e.U(11250000000000000000000n), // total value locked (11250 EGLD = 10000 EGLD + 1250 EGLD from delegate creation)
      e.U64(1), // nb of nodes,
      e.U(1000), // high apr
      e.U(500), // low service fee so this delegation contract is selected instead of some other
    ],
  });
  console.log('Whitelist delegation contract success');

  await alice.callContract({
    callee: liquidStakingContract,
    funcName: 'delegate',
    value: 40000000000000000000n, // 40 EGLD,
    gasLimit: 45_000_000,
  });
  console.log('Delegate transaction success');

  const delegationContractDataDecoder = d.Tuple({
    contract: d.Addr(),
    total_value_locked: d.U(),
    cap: d.Option(d.U()),
    nr_nodes: d.U64(),
    apr: d.U(),
    service_fee: d.U(),
    delegation_score: d.U(),
    pending_to_delegate: d.U(),
    total_delegated: d.U(),
    pending_to_undelegate: d.U(),
    total_undelegated: d.U(),
    total_withdrawable: d.U(),
    outdated: d.Bool(),
    blacklisted: d.Bool(),
  });

  result = await world.query({
    callee: liquidStakingContract,
    funcName: 'getDelegationContractData',
    funcArgs: [
      stakingProviderDelegationContract,
    ],
  });
  let delegationContractData = delegationContractDataDecoder.topDecode(result.returnData[0]);
  console.log('Delegation contract data', delegationContractData);

  assert(delegationContractData.pending_to_delegate === 40000000000000000000n);

  await admin.callContract({
    callee: liquidStakingContract,
    funcName: 'delegatePendingAmount',
    gasLimit: 45_000_000,
    funcArgs: [
      stakingProviderDelegationContract,
    ],
  });
  console.log('Delegate pending amount transaction success');

  result = await world.query({
    callee: stakingProviderDelegationContract,
    funcName: 'getTotalActiveStake',
  });

  assert(d.U().topDecode(result.returnData[0]) === 11290000000000000000000n); // staked increased by 40 EGLD

  console.log('Liquid staking account balance before rewards', await liquidStakingContract.getAccountBalance());

  // Move forward 5 epochs
  await world.generateBlocks(20 * 5);

  const tx = await admin.callContract({
    callee: liquidStakingContract,
    funcName: 'claimRewardsFrom',
    gasLimit: 45_000_000,
    funcArgs: [
      stakingProviderDelegationContract,
    ],
  });
  console.log('Claim rewards from transaction success', tx.tx);

  console.log('Liquid staking account balance after rewards', await liquidStakingContract.getAccountBalance());

  result = await world.query({
    callee: liquidStakingContract,
    funcName: 'getDelegationContractData',
    funcArgs: [
      stakingProviderDelegationContract,
    ],
  });
  delegationContractData = delegationContractDataDecoder.topDecode(result.returnData[0]);
  console.log('Delegation contract data', delegationContractData);

  const kvs = await liquidStakingContract.getAccountWithKvs();
  const rewardsReserve = d.U().topDecode(kvs.kvs[e.Str('rewardsReserve').toTopHex()]);
  console.log('Rewards reserve', rewardsReserve);
  // const stringKvs = Object.keys(kvs.kvs).map((value) => d.Str().topDecode(value));
  // console.log('Liquid staking account balance', stringKvs.join('\n'));

  await admin.callContract({
    callee: liquidStakingContract,
    funcName: 'delegateRewards',
    gasLimit: 45_000_000,
    funcArgs: [
      e.U(rewardsReserve),
    ]
  });
  console.log('Delegate rewards transaction success');

  // Checking of balances is not reliable currently, since on subsequent running of tests the gas cost paid can differ
  // assertAccount(await alice.getAccountWithKvs(), {
  //   balance: 9999659595680000000n, // 9999737965910000000n, 9999668639750000000n
  //   kvs: [
  //     e.kvs.Esdts([
  //       { id: 'SEGLD-3ad2d0', amount: 40000000000000000000n },
  //     ]),
  //   ],
  // });
};

test('Test', async () => {
  // const kvs = await liquidStakingContract.getAccountWithKvs();
  //
  // for (const [key, value] of Object.entries(kvs.kvs)) {
  //   if (key === e.Str('admin').toTopHex()) {
  //     console.log('admin value: ', d.Addr().topDecode(value));
  //
  //     break;
  //   }
  // }

  // generate 20 blocks to pass an epoch and the smart contract deploys to be enabled
  await world.generateBlocks(20);

  const { stakingProviderDelegationContract } = await deployDelegationProvider();

  await setupLiquidStaking(stakingProviderDelegationContract);
}, { timeout: 0 });
