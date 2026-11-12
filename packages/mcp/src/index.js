'use strict';

const rpc = require('./rpc');

module.exports = {
  createRpcServer: rpc.createRpcServer,
  RpcError: rpc.RpcError,
  RPC_CODES: rpc.CODES,
  SUPPORTED_PROTOCOLS: rpc.SUPPORTED_PROTOCOLS,
};
