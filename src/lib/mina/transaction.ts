import {
  ZkappCommand,
  AccountUpdate,
  ZkappPublicInput,
  AccountUpdateLayout,
  FeePayerUnsigned,
  addMissingSignatures,
  TokenId,
  addMissingProofs,
} from '../account-update.js';
import { prettifyStacktrace } from '../errors.js';
import { Field } from '../core.js';
import { PrivateKey, PublicKey } from '../signature.js';
import { UInt32, UInt64 } from '../int.js';
import { Empty, Proof } from '../proof-system.js';
import { currentTransaction } from './transaction-context.js';
import { Provable } from '../provable.js';
import { assertPreconditionInvariants } from '../precondition.js';
import { Account } from './account.js';
import {
  type DeprecatedFeePayerSpec,
  type FeePayerSpec,
  activeInstance,
} from './mina-instance.js';
import * as Fetch from '../fetch.js';
import { type SendZkAppResponse, sendZkappQuery } from './graphql.js';
import { type FetchMode } from './transaction-context.js';
import { assertPromise } from '../util/assert.js';

export {
  type Transaction,
  type PendingTransaction,
  type IncludedTransaction,
  type RejectedTransaction,
  type PendingTransactionStatus,
  createTransaction,
  sendTransaction,
  newTransaction,
  getAccount,
  transaction,
  createRejectedTransaction,
  createIncludedTransaction,
};

/**
 * Defines the structure and operations associated with a transaction.
 * This type encompasses methods for serializing the transaction, signing it, generating proofs,
 * and submitting it to the network.
 */
type Transaction = {
  /**
   * Transaction structure used to describe a state transition on the Mina blockchain.
   */
  transaction: ZkappCommand;
  /**
   * Serializes the transaction to a JSON string.
   * @returns A string representation of the {@link Transaction}.
   */
  toJSON(): string;
  /**
   * Produces a pretty-printed JSON representation of the {@link Transaction}.
   * @returns A formatted string representing the transaction in JSON.
   */
  toPretty(): any;
  /**
   * Constructs the GraphQL query string used for submitting the transaction to a Mina daemon.
   * @returns The GraphQL query string for the {@link Transaction}.
   */
  toGraphqlQuery(): string;
  /**
   * Signs all {@link AccountUpdate}s included in the {@link Transaction} that require a signature.
   * {@link AccountUpdate}s that require a signature can be specified with `{AccountUpdate|SmartContract}.requireSignature()`.
   * @param additionalKeys The list of keys that should be used to sign the {@link Transaction}
   * @returns The {@link Transaction} instance with all required signatures applied.
   * @example
   * ```ts
   * const signedTx = transaction.sign([userPrivateKey]);
   * console.log('Transaction signed successfully.');
   * ```
   */
  sign(additionalKeys?: PrivateKey[]): Transaction;
  /**
   * Initiates the proof generation process for the {@link Transaction}. This asynchronous operation is
   * crucial for zero-knowledge-based transactions, where proofs are required to validate state transitions.
   * This can take some time.
   * @example
   * ```ts
   * await transaction.prove();
   * ```
   */
  prove(): Promise<(Proof<ZkappPublicInput, Empty> | undefined)[]>;
  /**
   * Submits the {@link Transaction} to the network. This method asynchronously sends the transaction
   * for processing. If successful, it returns a {@link PendingTransaction} instance, which can be used to monitor the transaction's progress.
   * If the transaction submission fails, this method throws an error that should be caught and handled appropriately.
   * @returns A promise that resolves to a {@link PendingTransaction} instance representing the submitted transaction if the submission is successful.
   * @throws An error if the transaction cannot be sent or processed by the network, containing details about the failure.
   * @example
   * ```ts
   * try {
   *   const pendingTransaction = await transaction.send();
   *   console.log('Transaction sent successfully to the Mina daemon.');
   * } catch (error) {
   *   console.error('Failed to send transaction to the Mina daemon:', error);
   * }
   * ```
   */
  send(): Promise<PendingTransaction>;
  /**
   * Sends the {@link Transaction} to the network. Unlike the standard {@link Transaction.send}, this function does not throw an error if internal errors are detected. Instead, it returns a {@link PendingTransaction} if the transaction is successfully sent for processing or a {@link RejectedTransaction} if it encounters errors during processing or is outright rejected by the Mina daemon.
   * @returns {Promise<PendingTransaction | RejectedTransaction>} A promise that resolves to a {@link PendingTransaction} if the transaction is accepted for processing, or a {@link RejectedTransaction} if the transaction fails or is rejected.
   * @example
   * ```ts
   * const result = await transaction.safeSend();
   * if (result.status === 'pending') {
   *   console.log('Transaction sent successfully to the Mina daemon.');
   * } else if (result.status === 'rejected') {
   *   console.error('Transaction failed with errors:', result.errors);
   * }
   * ```
   */
  safeSend(): Promise<PendingTransaction | RejectedTransaction>;
};

type PendingTransactionStatus = 'pending' | 'rejected';
/**
 * Represents a transaction that has been submitted to the blockchain but has not yet reached a final state.
 * The {@link PendingTransaction} type extends certain functionalities from the base {@link Transaction} type,
 * adding methods to monitor the transaction's progress towards being finalized (either included in a block or rejected).
 */
type PendingTransaction = Pick<
  Transaction,
  'transaction' | 'toJSON' | 'toPretty'
> & {
  /**
   * @property {PendingTransactionStatus} status The status of the transaction after being sent to the Mina daemon.
   * This property indicates the transaction's initial processing status but does not guarantee its eventual inclusion in a block.
   * A status of `pending` suggests the transaction was accepted by the Mina daemon for processing,
   * whereas a status of `rejected` indicates that the transaction was not accepted.
   * Use the {@link PendingTransaction.wait()} or {@link PendingTransaction.safeWait()} methods to track the transaction's progress towards finalization and to determine whether it's included in a block.
   * @example
   * ```ts
   * if (pendingTransaction.status === 'pending') {
   *   console.log('Transaction accepted for processing by the Mina daemon.');
   *   try {
   *     await pendingTransaction.wait();
   *     console.log('Transaction successfully included in a block.');
   *   } catch (error) {
   *     console.error('Transaction was rejected or failed to be included in a block:', error);
   *   }
   * } else {
   *   console.error('Transaction was not accepted for processing by the Mina daemon.');
   * }
   * ```
   */
  status: PendingTransactionStatus;

  /**
   * Waits for the transaction to be included in a block. This method polls the Mina daemon to check the transaction's status, and throws an error if the transaction is rejected.
   * @param {Object} [options] Configuration options for polling behavior.
   * @param {number} [options.maxAttempts] The maximum number of attempts to check the transaction status.
   * @param {number} [options.interval] The interval, in milliseconds, between status checks.
   * @returns {Promise<IncludedTransaction>} A promise that resolves to the transaction's final state or throws an error.
   * @throws {Error} If the transaction is rejected or fails to finalize within the given attempts.
   * @example
   * ```ts
   * try {
   *   const transaction = await pendingTransaction.wait({ maxAttempts: 10, interval: 2000 });
   *   console.log('Transaction included in a block.');
   * } catch (error) {
   *   console.error('Transaction rejected or failed to finalize:', error);
   * }
   * ```
   */
  wait(options?: {
    maxAttempts?: number;
    interval?: number;
  }): Promise<IncludedTransaction>;

  /**
   * Waits for the transaction to be included in a block. This method polls the Mina daemon to check the transaction's status
   * @param {Object} [options] Configuration options for polling behavior.
   * @param {number} [options.maxAttempts] The maximum number of polling attempts.
   * @param {number} [options.interval] The time interval, in milliseconds, between each polling attempt.
   * @returns {Promise<IncludedTransaction | RejectedTransaction>} A promise that resolves to the transaction's final state.
   * @example
   * ```ts
   * const transaction = await pendingTransaction.wait({ maxAttempts: 5, interval: 1000 });
   * console.log(transaction.status); // 'included' or 'rejected'
   * ```
   */
  safeWait(options?: {
    maxAttempts?: number;
    interval?: number;
  }): Promise<IncludedTransaction | RejectedTransaction>;

  /**
   * Returns the transaction hash as a string identifier.
   * @property {string} The hash of the transaction.
   * @example
   * ```ts
   * const txHash = pendingTransaction.hash;
   * console.log(`Transaction hash: ${txHash}`);
   * ```
   */
  hash: string;

  /**
   * Optional. Contains response data from a ZkApp transaction submission.
   *
   * @property {SendZkAppResponse} [data] The response data from the transaction submission.
   */
  data?: SendZkAppResponse;

  /**
   * An array of error messages related to the transaction processing.
   *
   * @property {string[]} errors Descriptive error messages if the transaction encountered issues during processing.
   * @example
   * ```ts
   * if (!pendingTransaction.status === 'rejected') {
   *   console.error(`Transaction errors: ${pendingTransaction.errors.join(', ')}`);
   * }
   * ```
   */
  errors: string[];
};

/**
 * Represents a transaction that has been successfully included in a block.
 */
type IncludedTransaction = Pick<
  PendingTransaction,
  'transaction' | 'toJSON' | 'toPretty' | 'hash' | 'data'
> & {
  /**
   * @property {string} status The final status of the transaction, indicating successful inclusion in a block.
   * @example
   * ```ts
   * try {
   *   const includedTx: IncludedTransaction = await pendingTransaction.wait();
   *   // If wait() resolves, it means the transaction was successfully included.
   *   console.log(`Transaction ${includedTx.hash} included in a block.`);
   * } catch (error) {
   *   // If wait() throws, the transaction was not included in a block.
   *   console.error('Transaction failed to be included in a block:', error);
   * }
   * ```
   */
  status: 'included';
};

/**
 * Represents a transaction that has been rejected and not included in a blockchain block.
 */
type RejectedTransaction = Pick<
  PendingTransaction,
  'transaction' | 'toJSON' | 'toPretty' | 'hash' | 'data'
> & {
  /**
   * @property {string} status The final status of the transaction, specifically indicating that it has been rejected.
   * @example
   * ```ts
   * try {
   *   const txResult = await pendingTransaction.wait();
   *   // This line will not execute if the transaction is rejected, as `.wait()` will throw an error instead.
   *   console.log(`Transaction ${txResult.hash} was successfully included in a block.`);
   * } catch (error) {
   *   console.error(`Transaction ${error.transaction.hash} was rejected.`);
   *   error.errors.forEach((error, i) => {
   *    console.error(`Error ${i + 1}: ${error}`);
   *   });
   * }
   * ```
   */
  status: 'rejected';

  /**
   * @property {string[]} errors An array of error messages detailing the reasons for the transaction's rejection.
   */
  errors: string[];
};

async function createTransaction(
  feePayer: DeprecatedFeePayerSpec,
  f: () => Promise<unknown>,
  numberOfRuns: 0 | 1 | undefined,
  {
    fetchMode = 'cached' as FetchMode,
    isFinalRunOutsideCircuit = true,
    proofsEnabled = true,
  } = {}
): Promise<Transaction> {
  if (currentTransaction.has()) {
    throw new Error('Cannot start new transaction within another transaction');
  }
  let feePayerSpec: {
    sender?: PublicKey;
    feePayerKey?: PrivateKey;
    fee?: number | string | UInt64;
    memo?: string;
    nonce?: number;
  };
  if (feePayer === undefined) {
    feePayerSpec = {};
  } else if (feePayer instanceof PrivateKey) {
    feePayerSpec = { feePayerKey: feePayer, sender: feePayer.toPublicKey() };
  } else if (feePayer instanceof PublicKey) {
    feePayerSpec = { sender: feePayer };
  } else {
    feePayerSpec = feePayer;
    if (feePayerSpec.sender === undefined)
      feePayerSpec.sender = feePayerSpec.feePayerKey?.toPublicKey();
  }
  let { feePayerKey, sender, fee, memo = '', nonce } = feePayerSpec;

  let transactionId = currentTransaction.enter({
    sender,
    layout: new AccountUpdateLayout(),
    fetchMode,
    isFinalRunOutsideCircuit,
    numberOfRuns,
  });

  // run circuit
  try {
    if (fetchMode === 'test') {
      await Provable.runUnchecked(async () => {
        await assertPromise(f());
        Provable.asProver(() => {
          let tx = currentTransaction.get();
          tx.layout.toConstantInPlace();
        });
      });
    } else {
      await assertPromise(f());
    }
  } catch (err) {
    currentTransaction.leave(transactionId);
    throw err;
  }

  let accountUpdates = currentTransaction
    .get()
    .layout.toFlatList({ mutate: true });

  try {
    // check that on-chain values weren't used without setting a precondition
    for (let accountUpdate of accountUpdates) {
      assertPreconditionInvariants(accountUpdate);
    }
  } catch (err) {
    currentTransaction.leave(transactionId);
    throw err;
  }

  let feePayerAccountUpdate: FeePayerUnsigned;
  if (sender !== undefined) {
    // if senderKey is provided, fetch account to get nonce and mark to be signed
    let nonce_;
    let senderAccount = getAccount(sender, TokenId.default);

    if (nonce === undefined) {
      nonce_ = senderAccount.nonce;
    } else {
      nonce_ = UInt32.from(nonce);
      senderAccount.nonce = nonce_;
      Fetch.addCachedAccount(senderAccount);
    }
    feePayerAccountUpdate = AccountUpdate.defaultFeePayer(sender, nonce_);
    if (feePayerKey !== undefined)
      feePayerAccountUpdate.lazyAuthorization!.privateKey = feePayerKey;
    if (fee !== undefined) {
      feePayerAccountUpdate.body.fee =
        fee instanceof UInt64 ? fee : UInt64.from(String(fee));
    }
  } else {
    // otherwise use a dummy fee payer that has to be filled in later
    feePayerAccountUpdate = AccountUpdate.dummyFeePayer();
  }

  let transaction: ZkappCommand = {
    accountUpdates,
    feePayer: feePayerAccountUpdate,
    memo,
  };

  currentTransaction.leave(transactionId);
  return newTransaction(transaction, proofsEnabled);
}

function newTransaction(transaction: ZkappCommand, proofsEnabled?: boolean) {
  let self: Transaction = {
    transaction,
    sign(additionalKeys?: PrivateKey[]) {
      self.transaction = addMissingSignatures(self.transaction, additionalKeys);
      return self;
    },
    async prove() {
      let { zkappCommand, proofs } = await addMissingProofs(self.transaction, {
        proofsEnabled,
      });
      self.transaction = zkappCommand;
      return proofs;
    },
    toJSON() {
      let json = ZkappCommand.toJSON(self.transaction);
      return JSON.stringify(json);
    },
    toPretty() {
      return ZkappCommand.toPretty(self.transaction);
    },
    toGraphqlQuery() {
      return sendZkappQuery(self.toJSON());
    },
    async send() {
      const pendingTransaction = await sendTransaction(self);
      if (pendingTransaction.errors.length > 0) {
        throw Error(
          `Transaction failed with errors:\n- ${pendingTransaction.errors.join(
            '\n- '
          )}`
        );
      }
      return pendingTransaction;
    },
    async safeSend() {
      const pendingTransaction = await sendTransaction(self);
      if (pendingTransaction.errors.length > 0) {
        return createRejectedTransaction(
          pendingTransaction,
          pendingTransaction.errors
        );
      }
      return pendingTransaction;
    },
  };
  return self;
}

/**
 * Construct a smart contract transaction. Within the callback passed to this function,
 * you can call into the methods of smart contracts.
 *
 * ```
 * let tx = await Mina.transaction(sender, async () => {
 *   await myZkapp.update();
 *   await someOtherZkapp.someOtherMethod();
 * });
 * ```
 *
 * @return A transaction that can subsequently be submitted to the chain.
 */
function transaction(
  sender: FeePayerSpec,
  f: () => Promise<void>
): Promise<Transaction>;
function transaction(f: () => Promise<void>): Promise<Transaction>;
/**
 * @deprecated It's deprecated to pass in the fee payer's private key. Pass in the public key instead.
 * ```
 * // good
 * Mina.transaction(publicKey, ...);
 * Mina.transaction({ sender: publicKey }, ...);
 *
 * // deprecated
 * Mina.transaction(privateKey, ...);
 * Mina.transaction({ feePayerKey: privateKey }, ...);
 * ```
 */
function transaction(
  sender: DeprecatedFeePayerSpec,
  f: () => Promise<void>
): Promise<Transaction>;
function transaction(
  senderOrF: DeprecatedFeePayerSpec | (() => Promise<void>),
  fOrUndefined?: () => Promise<void>
): Promise<Transaction> {
  let sender: DeprecatedFeePayerSpec;
  let f: () => Promise<void>;
  if (fOrUndefined !== undefined) {
    sender = senderOrF as DeprecatedFeePayerSpec;
    f = fOrUndefined;
  } else {
    sender = undefined;
    f = senderOrF as () => Promise<void>;
  }
  return activeInstance.transaction(sender, f);
}

async function sendTransaction(txn: Transaction) {
  return await activeInstance.sendTransaction(txn);
}

/**
 * @return The account data associated to the given public key.
 */
function getAccount(publicKey: PublicKey, tokenId?: Field): Account {
  return activeInstance.getAccount(publicKey, tokenId);
}

function createRejectedTransaction(
  {
    transaction,
    data,
    toJSON,
    toPretty,
    hash,
  }: Omit<PendingTransaction, 'wait' | 'safeWait'>,
  errors: string[]
): RejectedTransaction {
  return {
    status: 'rejected',
    errors,
    transaction,
    toJSON,
    toPretty,
    hash,
    data,
  };
}

function createIncludedTransaction({
  transaction,
  data,
  toJSON,
  toPretty,
  hash,
}: Omit<PendingTransaction, 'wait' | 'safeWait'>): IncludedTransaction {
  return {
    status: 'included',
    transaction,
    toJSON,
    toPretty,
    hash,
    data,
  };
}
