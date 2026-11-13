'use strict';

const rpc = require('./rpc');
const { runMcp } = require('./main');
const { parseMcpArgs, helpText } = require('./args');

module.exports = {
  runMcp,
  parseMcpArgs,
  helpText,
  createRpcServer: rpc.createRpcServer,
  RpcError: rpc.RpcError,
  RPC_CODES: rpc.CODES,
  SUPPORTED_PROTOCOLS: rpc.SUPPORTED_PROTOCOLS,
};
