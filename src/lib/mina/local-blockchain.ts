import { SimpleLedger } from './transaction-logic/ledger.js';
import { Ml } from '../ml/conversion.js';
import { transactionCommitments } from '../../mina-signer/src/sign-zkapp-command.js';
import { Ledger, Test } from '../../snarky.js';
import { Field } from '../core.js';
import { UInt32, UInt64 } from '../int.js';
import { PrivateKey, PublicKey } from '../signature.js';
import { Account } from './account.js';
import {
  ZkappCommand,
  TokenId,
  Authorization,
  Actions,
} from '../account-update.js';
import { NetworkId } from '../../mina-signer/src/types.js';
import { Types, TypesBigint } from '../../bindings/mina-transaction/types.js';
import { invalidTransactionError } from './errors.js';
import {
  Transaction,
  PendingTransaction,
  createTransaction,
  createIncludedTransaction,
  createRejectedTransaction,
  IncludedTransaction,
  RejectedTransaction,
  PendingTransactionStatus,
} from './transaction.js';
import {
  type DeprecatedFeePayerSpec,
  type ActionStates,
  Mina,
  defaultNetworkConstants,
} from './mina-instance.js';
import {
  reportGetAccountError,
  defaultNetworkState,
  verifyTransactionLimits,
  verifyAccountUpdate,
} from './transaction-validation.js';

export { LocalBlockchain };
/**
 * A mock Mina blockchain running locally and useful for testing.
 */
function LocalBlockchain({
  proofsEnabled = true,
  enforceTransactionLimits = true,
  networkId = 'testnet' as NetworkId,
} = {}) {
  const slotTime = 3 * 60 * 1000;
  const startTime = Date.now();
  const genesisTimestamp = UInt64.from(startTime);
  const ledger = Ledger.create();
  let networkState = defaultNetworkState();
  let minaNetworkId: NetworkId = networkId;

  function addAccount(publicKey: PublicKey, balance: string) {
    ledger.addAccount(Ml.fromPublicKey(publicKey), balance);
  }

  let testAccounts: {
    publicKey: PublicKey;
    privateKey: PrivateKey;
  }[] = [];

  for (let i = 0; i < 10; ++i) {
    let MINA = 10n ** 9n;
    const largeValue = 1000n * MINA;
    const k = PrivateKey.random();
    const pk = k.toPublicKey();
    addAccount(pk, largeValue.toString());
    testAccounts.push({ privateKey: k, publicKey: pk });
  }

  const events: Record<string, any> = {};
  const actions: Record<
    string,
    Record<string, { actions: string[][]; hash: string }[]>
  > = {};

  return {
    getNetworkId: () => minaNetworkId,
    proofsEnabled,
    /**
     * @deprecated use {@link Mina.getNetworkConstants}
     */
    accountCreationFee: () => defaultNetworkConstants.accountCreationFee,
    getNetworkConstants() {
      return {
        ...defaultNetworkConstants,
        genesisTimestamp,
      };
    },
    currentSlot() {
      return UInt32.from(
        Math.ceil((new Date().valueOf() - startTime) / slotTime)
      );
    },
    hasAccount(publicKey: PublicKey, tokenId: Field = TokenId.default) {
      return !!ledger.getAccount(
        Ml.fromPublicKey(publicKey),
        Ml.constFromField(tokenId)
      );
    },
    getAccount(
      publicKey: PublicKey,
      tokenId: Field = TokenId.default
    ): Account {
      let accountJson = ledger.getAccount(
        Ml.fromPublicKey(publicKey),
        Ml.constFromField(tokenId)
      );
      if (accountJson === undefined) {
        throw new Error(
          reportGetAccountError(publicKey.toBase58(), TokenId.toBase58(tokenId))
        );
      }
      return Types.Account.fromJSON(accountJson);
    },
    getNetworkState() {
      return networkState;
    },
    async sendTransaction(txn: Transaction): Promise<PendingTransaction> {
      txn.sign();

      let zkappCommandJson = ZkappCommand.toJSON(txn.transaction);
      let commitments = transactionCommitments(
        TypesBigint.ZkappCommand.fromJSON(zkappCommandJson),
        minaNetworkId
      );

      if (enforceTransactionLimits) verifyTransactionLimits(txn.transaction);

      // create an ad-hoc ledger to record changes to accounts within the transaction
      let simpleLedger = SimpleLedger.create();

      for (const update of txn.transaction.accountUpdates) {
        let authIsProof = !!update.authorization.proof;
        let kindIsProof = update.body.authorizationKind.isProved.toBoolean();
        // checks and edge case where a proof is expected, but the developer forgot to invoke await tx.prove()
        // this resulted in an assertion OCaml error, which didn't contain any useful information
        if (kindIsProof && !authIsProof) {
          throw Error(
            `The actual authorization does not match the expected authorization kind. Did you forget to invoke \`await tx.prove();\`?`
          );
        }

        let account = simpleLedger.load(update.body);

        // the first time we encounter an account, use it from the persistent ledger
        if (account === undefined) {
          let accountJson = ledger.getAccount(
            Ml.fromPublicKey(update.body.publicKey),
            Ml.constFromField(update.body.tokenId)
          );
          if (accountJson !== undefined) {
            let storedAccount = Account.fromJSON(accountJson);
            simpleLedger.store(storedAccount);
            account = storedAccount;
          }
        }

        // TODO: verify account update even if the account doesn't exist yet, using a default initial account
        if (account !== undefined) {
          let publicInput = update.toPublicInput(txn.transaction);
          await verifyAccountUpdate(
            account,
            update,
            publicInput,
            commitments,
            this.proofsEnabled,
            this.getNetworkId()
          );
          simpleLedger.apply(update);
        }
      }

      let status: PendingTransactionStatus = 'pending';
      const errors: string[] = [];
      try {
        ledger.applyJsonTransaction(
          JSON.stringify(zkappCommandJson),
          defaultNetworkConstants.accountCreationFee.toString(),
          JSON.stringify(networkState)
        );
      } catch (err: any) {
        status = 'rejected';
        try {
          const errorMessages = JSON.parse(err.message);
          const formattedError = invalidTransactionError(
            txn.transaction,
            errorMessages,
            {
              accountCreationFee:
                defaultNetworkConstants.accountCreationFee.toString(),
            }
          );
          errors.push(formattedError);
        } catch (parseError: any) {
          const fallbackErrorMessage =
            err.message || parseError.message || 'Unknown error occurred';
          errors.push(fallbackErrorMessage);
        }
      }

      // fetches all events from the transaction and stores them
      // events are identified and associated with a publicKey and tokenId
      txn.transaction.accountUpdates.forEach((p, i) => {
        let pJson = zkappCommandJson.accountUpdates[i];
        let addr = pJson.body.publicKey;
        let tokenId = pJson.body.tokenId;
        events[addr] ??= {};
        if (p.body.events.data.length > 0) {
          events[addr][tokenId] ??= [];
          let updatedEvents = p.body.events.data.map((data) => {
            return {
              data,
              transactionInfo: {
                transactionHash: '',
                transactionStatus: '',
                transactionMemo: '',
              },
            };
          });
          events[addr][tokenId].push({
            events: updatedEvents,
            blockHeight: networkState.blockchainLength,
            globalSlot: networkState.globalSlotSinceGenesis,
            // The following fields are fetched from the Mina network. For now, we mock these values out
            // since networkState does not contain these fields.
            blockHash: '',
            parentBlockHash: '',
            chainStatus: '',
          });
        }

        // actions/sequencing events

        // most recent action state
        let storedActions = actions[addr]?.[tokenId];
        let latestActionState_ =
          storedActions?.[storedActions.length - 1]?.hash;
        // if there exists no hash, this means we initialize our latest hash with the empty state
        let latestActionState =
          latestActionState_ !== undefined
            ? Field(latestActionState_)
            : Actions.emptyActionState();

        actions[addr] ??= {};
        if (p.body.actions.data.length > 0) {
          let newActionState = Actions.updateSequenceState(
            latestActionState,
            p.body.actions.hash
          );
          actions[addr][tokenId] ??= [];
          actions[addr][tokenId].push({
            actions: pJson.body.actions,
            hash: newActionState.toString(),
          });
        }
      });

      const hash = Test.transactionHash.hashZkAppCommand(txn.toJSON());
      const pendingTransaction: Omit<PendingTransaction, 'wait' | 'safeWait'> =
        {
          status,
          errors,
          transaction: txn.transaction,
          hash,
          toJSON: txn.toJSON,
          toPretty: txn.toPretty,
        };

      const wait = async (_options?: {
        maxAttempts?: number;
        interval?: number;
      }): Promise<IncludedTransaction> => {
        const pendingTransaction = await safeWait(_options);
        if (pendingTransaction.status === 'rejected') {
          throw Error(
            `Transaction failed with errors:\n${pendingTransaction.errors.join(
              '\n'
            )}`
          );
        }
        return pendingTransaction;
      };

      const safeWait = async (_options?: {
        maxAttempts?: number;
        interval?: number;
      }): Promise<IncludedTransaction | RejectedTransaction> => {
        if (status === 'rejected') {
          return createRejectedTransaction(
            pendingTransaction,
            pendingTransaction.errors
          );
        }
        return createIncludedTransaction(pendingTransaction);
      };

      return {
        ...pendingTransaction,
        wait,
        safeWait,
      };
    },
    async transaction(sender: DeprecatedFeePayerSpec, f: () => Promise<void>) {
      // TODO we run the transaction twice to match the behaviour of `Network.transaction`
      let tx = await createTransaction(sender, f, 0, {
        isFinalRunOutsideCircuit: false,
        proofsEnabled: this.proofsEnabled,
        fetchMode: 'test',
      });
      let hasProofs = tx.transaction.accountUpdates.some(
        Authorization.hasLazyProof
      );
      return await createTransaction(sender, f, 1, {
        isFinalRunOutsideCircuit: !hasProofs,
        proofsEnabled: this.proofsEnabled,
      });
    },
    applyJsonTransaction(json: string) {
      return ledger.applyJsonTransaction(
        json,
        defaultNetworkConstants.accountCreationFee.toString(),
        JSON.stringify(networkState)
      );
    },
    async fetchEvents(publicKey: PublicKey, tokenId: Field = TokenId.default) {
      // Return events in reverse chronological order (latest events at the beginning)
      const reversedEvents = (
        events?.[publicKey.toBase58()]?.[TokenId.toBase58(tokenId)] ?? []
      ).reverse();
      return reversedEvents;
    },
    async fetchActions(
      publicKey: PublicKey,
      actionStates?: ActionStates,
      tokenId: Field = TokenId.default
    ) {
      return this.getActions(publicKey, actionStates, tokenId);
    },
    getActions(
      publicKey: PublicKey,
      actionStates?: ActionStates,
      tokenId: Field = TokenId.default
    ): { hash: string; actions: string[][] }[] {
      let currentActions =
        actions?.[publicKey.toBase58()]?.[TokenId.toBase58(tokenId)] ?? [];
      let { fromActionState, endActionState } = actionStates ?? {};

      let emptyState = Actions.emptyActionState();
      if (endActionState?.equals(emptyState).toBoolean()) return [];

      let start = fromActionState?.equals(emptyState).toBoolean()
        ? undefined
        : fromActionState?.toString();
      let end = endActionState?.toString();

      let startIndex = 0;
      if (start) {
        let i = currentActions.findIndex((e) => e.hash === start);
        if (i === -1) throw Error(`getActions: fromActionState not found.`);
        startIndex = i + 1;
      }
      let endIndex: number | undefined;
      if (end) {
        let i = currentActions.findIndex((e) => e.hash === end);
        if (i === -1) throw Error(`getActions: endActionState not found.`);
        endIndex = i + 1;
      }
      return currentActions.slice(startIndex, endIndex);
    },
    addAccount,
    /**
     * An array of 10 test accounts that have been pre-filled with
     * 30000000000 units of currency.
     */
    testAccounts,
    setGlobalSlot(slot: UInt32 | number) {
      networkState.globalSlotSinceGenesis = UInt32.from(slot);
    },
    incrementGlobalSlot(increment: UInt32 | number) {
      networkState.globalSlotSinceGenesis =
        networkState.globalSlotSinceGenesis.add(increment);
    },
    setBlockchainLength(height: UInt32) {
      networkState.blockchainLength = height;
    },
    setTotalCurrency(currency: UInt64) {
      networkState.totalCurrency = currency;
    },
    setProofsEnabled(newProofsEnabled: boolean) {
      this.proofsEnabled = newProofsEnabled;
    },
  };
}
// assert type compatibility without preventing LocalBlockchain to return additional properties / methods
LocalBlockchain satisfies (...args: any) => Mina;
