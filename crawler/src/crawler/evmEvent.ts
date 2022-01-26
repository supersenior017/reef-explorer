import { Contract as EthContract, utils, BigNumber } from 'ethers';
import { nodeProvider } from '../utils/connector';
import { resolveSigner } from './extrinsic';
import {
  ExtrinsicBody,
  Event,
  Contract,
  EVMCall,
  AccountHead,
  ABI,
  EvmLog,
  TokenHolder,
  EvmLogWithDecodedEvent,
  TokenBalanceHead,
  BytecodeLog,
  BytecodeLogWithBlockId,
  Transfer,
  NativeTokenHolderHead,
} from './types';
import { getContractDB } from '../queries/evmEvent';
import {
  dropDuplicates,
  REEF_CONTRACT_ADDRESS,
  removeUndefinedItem,
  resolvePromisesAsChunks,
} from '../utils/utils';

const preprocessBytecode = (bytecode: string) => {
  const start = bytecode.indexOf('6080604052');
  const end = bytecode.indexOf('a265627a7a72315820') !== -1
    ? bytecode.indexOf('a265627a7a72315820')
    : bytecode.indexOf('a264697066735822');
  return {
    context: bytecode.slice(start, end),
    args: bytecode.slice(end),
  };
};

const findContractEvent = (events: Event[]): Event | undefined => events.find(
  ({ event }) => event.section === 'evm' && event.method === 'Created',
);

export const isExtrinsicEVMCreate = ({
  extrinsic: { method },
  events,
}: ExtrinsicBody): boolean => method.section === 'evm'
  && method.method === 'create'
  && !!findContractEvent(events);

export const isExtrinsicEvmClaimAccount = ({
  extrinsic: {
    method: { section, method },
  },
}: ExtrinsicBody): boolean => section === 'evmAccounts' && method === 'claimDefaultAccount';

export const isExtrinsicEVMCall = ({
  extrinsic: { method },
}: ExtrinsicBody): boolean => method.section === 'evm' && method.method === 'call';

export const extrinsicToEvmClaimAccount = ({
  events,
  blockId,
  timestamp,
}: ExtrinsicBody): AccountHead[] => {
  const [address] = events[0].event.data;
  return [{
    blockId, address: address.toString(), active: true, timestamp,
  }];
};

export const extrinsicToContract = ({
  extrinsic,
  events,
  id,
  timestamp,
}: ExtrinsicBody): Contract => {
  const { args } = extrinsic;
  const contractEvent = findContractEvent(events)!;
  const address = contractEvent.event.data[0].toString();
  const reserveEvent = events.find((evn) => nodeProvider.getProvider().api.events.balances.Reserved.is(evn.event))!;
  const signer = reserveEvent.event.data[0].toString();
  const bytecode = args[0].toString();
  const gasLimit = args[2].toString();
  const storageLimit = args[3].toString();

  const { context: bytecodeContext, args: bytecodeArguments } = preprocessBytecode(bytecode);
  return {
    signer,
    address,
    bytecode,
    gasLimit,
    timestamp,
    storageLimit,
    bytecodeContext,
    extrinsicId: id,
    bytecodeArguments,
  };
};

export const extrinsicToEVMCall = ({
  extrinsic,
  status,
  id: extrinsicId,
  timestamp,
}: ExtrinsicBody): EVMCall => {
  const account = resolveSigner(extrinsic);
  const args: any[] = extrinsic.args.map((arg) => arg.toJSON());
  const contractAddress: string = args[0];
  const data = JSON.stringify(args.slice(0, args.length - 2));
  const gasLimit = args.length >= 3 ? args[args.length - 2] : 0;
  const storageLimit = args.length >= 3 ? args[args.length - 1] : 0;

  return {
    data,
    status,
    account,
    gasLimit,
    timestamp,
    extrinsicId,
    storageLimit,
    contractAddress,
  };
};

export const isEventEvmLog = ({ event: { method, section } }: Event): boolean => method === 'Log' && section === 'evm';

export const eventToEvmLog = ({ event }: Event): BytecodeLog => (event.data.toJSON() as any)[0];

const getContractBalance = (
  address: string,
  contractAddress: string,
  abi: ABI,
) => nodeProvider.query(async (provider): Promise<string> => {
  const contract = new EthContract(contractAddress, abi, provider);
  return contract.balanceOf(address);
});

const extractEvmLog = async (
  event: BytecodeLogWithBlockId,
): Promise<EvmLog | undefined> => {
  const result = await getContractDB(event.address);
  if (result.length === 0) {
    return undefined;
  }

  return {
    ...event,
    name: result[0].name,
    abis: result[0].compiled_data,
    decimals: result[0].contract_data.decimals,
  };
};

const decodeEvmLog = (event: EvmLog): EvmLogWithDecodedEvent => {
  const {
    abis, data, name, topics,
  } = event;
  const abi = new utils.Interface(abis[name]);
  const result = abi.parseLog({ topics, data });
  return { ...event, decodedEvent: result };
};

const erc20TransferEvent = ({
  address,
  decimals,
  decodedEvent,
  abis,
  name,
  blockId,
  timestamp,
}: EvmLogWithDecodedEvent): TokenBalanceHead[] => [
  {
    blockId,
    decimals,
    timestamp,
    abi: abis[name],
    contractAddress: address,
    signerAddress: decodedEvent.args[0],
  },
  {
    blockId,
    decimals,
    timestamp,
    abi: abis[name],
    contractAddress: address,
    signerAddress: decodedEvent.args[1],
  },
];

export const extractTokenBalance = async ({
  decimals,
  abi,
  contractAddress,
  signerAddress,
  blockId,
  timestamp,
}: TokenBalanceHead): Promise<TokenHolder> => {
  const [balance, signerAddr] = await Promise.all([
    getContractBalance(signerAddress, contractAddress, abi),
    nodeProvider.query((provider) => provider.api.query.evmAccounts.accounts(signerAddress)),
  ]);

  const address = signerAddr.toJSON();

  return {
    blockId,
    decimals,
    timestamp,
    contractAddress,
    evmAddress: address === null ? signerAddress : '',
    balance: balance.toString(),
    type: address === null ? 'Contract' : 'Account',
    signer: address === null ? '' : `${address}`,
  };
};

export const extractEvmLogHeaders = (
  extrinsicEvmCalls: ExtrinsicBody[],
): Promise<EvmLog | undefined>[] => extrinsicEvmCalls
  .map(({
    events, blockId, timestamp, id, signedData,
  }) => events.map((event) => ({
    event, blockId, timestamp, extrinsicId: id, signedData,
  })))
  .flat()
  .filter(
    ({ event: { event: { method, section } } }) => method === 'Log' && section === 'evm',
  )
  .map(({
    event, blockId, timestamp, extrinsicId, signedData,
  }): BytecodeLogWithBlockId => {
    const a = (event.event.data.toJSON() as any)[0];
    return {
      ...a, timestamp, blockId, extrinsicId, signedData,
    };
  })
  .map(extractEvmLog);

export const extractTokenTransfer = (evmLogs: (EvmLog | undefined)[]): Promise<Transfer|undefined>[] => evmLogs
  .filter(removeUndefinedItem)
  .map(decodeEvmLog)
  .filter(({ decodedEvent }) => decodedEvent.name === 'Transfer')
  .map(async ({
    decodedEvent, timestamp, address, blockId, name, extrinsicId, signedData,
  }) => {
    const [fromEvmAddress, toEvmAddress, amount] = decodedEvent.args;
    const [fromAddressQ, toAddressQ] = await Promise.all([
      nodeProvider.query((provider) => provider.api.query.evmAccounts.accounts(fromEvmAddress)),
      nodeProvider.query((provider) => provider.api.query.evmAccounts.accounts(toEvmAddress)),
    ]);
    const toAddress = toAddressQ.toString();
    const fromAddress = fromAddressQ.toString();

    return {
      blockId,
      timestamp,
      denom: name,
      extrinsicId,
      toEvmAddress,
      success: true,
      fromEvmAddress,
      errorMessage: '',
      tokenAddress: address,
      amount: amount.toString(),
      toAddress: toAddress === '' ? 'null' : toAddress,
      fromAddress: fromAddress === '' ? 'null' : fromAddress,
      feeAmount: BigNumber.from(signedData.fee.partialFee).toString(),
    };
  });

export const extractTokenTransferEvents = (evmLogs: (EvmLog | undefined)[]): TokenBalanceHead[] => evmLogs
  .filter(removeUndefinedItem)
  .map(decodeEvmLog)
  .filter(({ decodedEvent }) => decodedEvent.name === 'Transfer')
  .map(erc20TransferEvent)
  .flat();

export const tokenHolderToAccount = ({ signer, blockId, timestamp }: TokenHolder): AccountHead[] => [
  {
    active: true, address: signer, blockId, timestamp,
  },
];

const extractNativeTokenHolderFromTransfer = ({
  fromAddress, toAddress, blockId, timestamp,
}: Transfer): NativeTokenHolderHead[] => [
  {
    timestamp, blockId, signerAddress: fromAddress, decimals: 18, contractAddress: REEF_CONTRACT_ADDRESS,
  },
  {
    timestamp, blockId, signerAddress: toAddress, decimals: 18, contractAddress: REEF_CONTRACT_ADDRESS,
  },
];

const nativeTokenHolder = async (tokenHolderHead: NativeTokenHolderHead): Promise<TokenHolder> => {
  const signer = tokenHolderHead.signerAddress;
  const balance = await nodeProvider.query((provider) => provider.api.derive.balances.all(tokenHolderHead.signerAddress));

  return {
    ...tokenHolderHead,
    signer,
    type: 'Account',
    evmAddress: '',
    balance: balance.freeBalance.toString(),
  };
};

export const extractNativeTokenHoldersFromTransfers = async (transfers: Transfer[]): Promise<TokenHolder[]> => {
  const nativeTokenHoldersHead = dropDuplicates(
    transfers
      .map(extractNativeTokenHolderFromTransfer)
      .flat(),
    'signerAddress',
  );
  return resolvePromisesAsChunks(
    nativeTokenHoldersHead
      .map(nativeTokenHolder),
  );
};
