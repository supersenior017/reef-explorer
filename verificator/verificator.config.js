// @ts-check
require('dotenv').config();
module.exports = {
  pollingTime: 30 * 1000,
  nodeWs: 'wss://rpc-testnet.reefscan.com/ws',
  postgresConnParams: {
    user: process.env.POSTGRES_USER || 'reefexplorer',
    host: process.env.POSTGRES_HOST || 'postgres',
    database: process.env.POSTGRES_DATABASE || 'reefexplorer',
    password: process.env.POSTGRES_PASSWORD || 'reefexplorer',
    port: parseInt(process.env.POSTGRES_PORT, 10) || 5432,
  },
};
