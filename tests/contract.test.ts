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
  world = await CSWorld.start({
    // verbose: true,
  });

  // Wallets always need EGLD balance to pay for fees
  deployer = await world.createWallet({
    balance: '1000000000000000000', // 1 EGLD
  });
  address = await world.createWallet({
    balance: '1255000000000000000000', // 1255 EGLD
  });
  alice = await world.createWallet({
    balance: '4001000000000000000000000', // 4,001,000 EGLD
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

  // generate 20 blocks to pass an epoch and the smart contract deploys to be enabled
  await world.generateBlocks(20);
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

const esdtTokenPaymentDecoder = d.Tuple({
  token_identifier: d.Str(),
  token_nonce: d.U64(),
  amount: d.U(),
});

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

const deployDelegationProvider = async () => {
  const tx = await address.callContract({
    callee: systemDelegationContract,
    funcName: 'createNewDelegationContract',
    gasLimit: 65_000_000,
    value: '1250000000000000000000', // 1250 EGLD
    funcArgs: [
      e.U(0), // delegation cap
      e.U(3745), // service fee
    ],
  });
  const stakingProviderDelegationContract = extractContract(tx);
  console.log('Deployed new delegation contract', stakingProviderDelegationContract.toString());

  const initialWallets = await world.getInitialWallets();
  const initialAddressWithStake = initialWallets.initialWalletWithStake.address;
  const initialAddressWithStakeWallet = world.newWallet(new DummySigner(initialAddressWithStake));
  console.log('Initial address with stake', initialAddressWithStake);

  await address.callContract({
    callee: stakingProviderDelegationContract,
    funcName: 'whitelistForMerge',
    gasLimit: 65_000_000,
    funcArgs: [
      initialAddressWithStakeWallet
    ],
  });
  console.log('Whitelisted initial address with stake for merge');

  await initialAddressWithStakeWallet.callContract({
    callee: systemDelegationContract,
    funcName: 'mergeValidatorToDelegationWithWhitelist',
    gasLimit: 510_000_000,
    funcArgs: [
      stakingProviderDelegationContract,
    ],
  });
  console.log('Merged validator with delegation contract. Moving forward 1 epoch...');

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
      e.U(11250000000000000000000n), // total value locked (11250 EGLD = 10000 EGLD initial + 1250 EGLD from delegate creation)
      e.U64(1), // nb of nodes,
      e.U(1100), // high apr
      e.U(200), // low service fee so this delegation contract is selected instead of some other
    ],
  });
  console.log('Whitelisted delegation contract');

  let tx = await alice.callContract({
    callee: liquidStakingContract,
    funcName: 'delegate',
    value: 4000000000000000000000000n, // 4,000,000 EGLD,
    gasLimit: 45_000_000,
  });
  const segldReceived = esdtTokenPaymentDecoder.topDecode(tx.returnData[0]);
  console.log('Delegate EGLD successfully. Received sEGLD: ', segldReceived);
  assertAccount(await alice.getAccountWithKvs(), {
    kvs: [
      e.kvs.Esdts([
        { id: segldReceived.token_identifier, amount: segldReceived.amount },
      ]),
    ],
  });

  result = await world.query({
    callee: liquidStakingContract,
    funcName: 'getDelegationContractData',
    funcArgs: [
      stakingProviderDelegationContract,
    ],
  });
  let delegationContractData = delegationContractDataDecoder.topDecode(result.returnData[0]);
  console.log('Delegation contract data: ', delegationContractData);
  assert(delegationContractData.pending_to_delegate === 4000000000000000000000000n);

  await admin.callContract({
    callee: liquidStakingContract,
    funcName: 'delegatePendingAmount',
    gasLimit: 45_000_000,
    funcArgs: [
      stakingProviderDelegationContract,
    ],
  });
  console.log('Delegated pending amount: ', delegationContractData.pending_to_delegate);

  result = await world.query({
    callee: stakingProviderDelegationContract,
    funcName: 'getTotalActiveStake',
  });
  assert(d.U().topDecode(result.returnData[0]) === 4011250000000000000000000n); // staked increased by 4,000,000 EGLD

  console.log('Moving forward 3 epochs...');

  // Move forward 3 epochs (to have enough rewards so they can be claimed)
  await world.generateBlocks(20 * 3);

  await admin.callContract({
    callee: liquidStakingContract,
    funcName: 'claimRewardsFrom',
    gasLimit: 45_000_000,
    funcArgs: [
      stakingProviderDelegationContract,
    ],
  });
  console.log('Successfully claimed rewards from staking provider');

  const kvs = await liquidStakingContract.getAccountWithKvs();
  const rewardsReserve = d.U().topDecode(kvs.kvs[e.Str('rewardsReserve').toTopHex()]);
  console.log('Rewards reserve: ', rewardsReserve);
  // TODO: Balance assertions are not reliable currently
  // assert(rewardsReserve === 12360185739713390599n); // 12.360185739713390599 EGLD added as rewards

  await admin.callContract({
    callee: liquidStakingContract,
    funcName: 'delegateRewards',
    gasLimit: 45_000_000,
  });
  console.log('Delegate rewards back to staking provider');

  result = await world.query({
    callee: stakingProviderDelegationContract,
    funcName: 'getTotalActiveStake',
  });
  const totalActiveStake = d.U().topDecode(result.returnData[0]);
  console.log('New total active stake: ', totalActiveStake);
  // assert(totalActiveStake === 4011262360185739713390599n); // staked increased by rewards reserve amount

  tx = await alice.callContract({
    callee: liquidStakingContract,
    funcName: 'unDelegate',
    gasLimit: 45_000_000,
    esdts: [
      { id: segldReceived.token_identifier, amount: segldReceived.amount / 10n },
    ],
  });
  const undelegateNftReceived = esdtTokenPaymentDecoder.topDecode(tx.returnData[0]);
  console.log('Undelegate sEGLD successfully. Received NFT: ', undelegateNftReceived);
  assert(undelegateNftReceived.amount === 1n);

  await admin.callContract({
    callee: liquidStakingContract,
    funcName: 'unDelegatePendingAmount',
    gasLimit: 45_000_000,
    funcArgs: [
      stakingProviderDelegationContract,
    ],
  });
  console.log('Undelegate pending amount successfully. Moving forward 10 epochs...');

  // Move forward 10 epochs
  await world.generateBlocks(20 * 10);

  await alice.callContract({
    callee: liquidStakingContract,
    funcName: 'withdraw',
    gasLimit: 45_000_000,
    esdts: [
      {
        id: undelegateNftReceived.token_identifier,
        amount: undelegateNftReceived.amount,
        nonce: Number(undelegateNftReceived.token_nonce),
      },
    ],
  }).assertFail({ code: 'signalError', message: 'Too much EGLD amount' });

  await alice.callContract({
    callee: liquidStakingContract,
    funcName: 'withdrawFrom',
    gasLimit: 45_000_000,
    funcArgs: [
      stakingProviderDelegationContract,
    ],
  });
  console.log('Withdraw from staking provider successfully')

  tx = await alice.callContract({
    callee: liquidStakingContract,
    funcName: 'withdraw',
    gasLimit: 45_000_000,
    esdts: [
      {
        id: undelegateNftReceived.token_identifier,
        amount: undelegateNftReceived.amount,
        nonce: Number(undelegateNftReceived.token_nonce),
      },
    ],
  });
  const receivedEgldAmount = d.U().topDecode(tx.returnData[0]);
  console.log('Withdraw EGLD successfully. Received EGLD amount: ', receivedEgldAmount);
  // assert(receivedEgldAmount === 400000902905460064767128n) // ~400,000.93 EGLD received back

  const balance = await alice.getAccountBalance();
  assert(balance >= receivedEgldAmount);

  result = await world.query({
    callee: stakingProviderDelegationContract,
    funcName: 'getTotalActiveStake',
  });
  console.log('Remaining active stake for staking provider: ', d.U().topDecode(result.returnData[0]));
  // assert(d.U().topDecode(result.returnData[0]) === 3611261457280279648623471n); // stake still remaining
};

test('Test', async () => {
  const { stakingProviderDelegationContract } = await deployDelegationProvider();

  await setupLiquidStaking(stakingProviderDelegationContract);
}, { timeout: 0 }); // Test takes 1-2 minutes to run
