import fetch from 'node-fetch';
import * as fs from 'fs';
import { parse, writeToStream } from 'fast-csv';
import { getLlpPrice } from './constants';

type OutputDataSchemaRow = {
  block_number: number;
  timestamp: number;
  user_address: string;
  token_address: string;
  token_balance: bigint; // Store as BigInt in USDC format
  token_symbol: string; // Should be empty string if not available
  usd_price: number; // Assign 0 if not available
};

interface BlockData {
  blockNumber: number;
  blockTimestamp: number;
}

const LOGX_SUBGRAPH_QUERY_URL = 'https://api.goldsky.com/api/public/project_clxspa1gpqpvl01w65jr93p57/subgraphs/LlpManager-linea/1.0.2/gn';
const PAGE_SIZE = 1000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const post = async (url: string, data: any, retries = 5): Promise<any> => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      if (response.status === 429 && retries > 0) {
        const retryAfter = response.headers.get('Retry-After');
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : 1000 * Math.pow(2, 5 - retries);
        console.warn(`Rate limited. Retrying after ${delay / 1000} seconds...`);
        await sleep(delay);
        return post(url, data, retries - 1);
      }
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`Error posting data:`, error);
    throw error;
  }
};

const getLiquidityData = async (blockNumber: number, skipPage: number, type: 'add' | 'remove'): Promise<any[]> => {
  const query = type === 'add' ? `
    query LiquidityQuery {
      addLiquidities(
        skip: ${skipPage},
        first: ${PAGE_SIZE},
        where: { block_number_lte: ${blockNumber} },
      ) {
        id
        account
        token
        amount
        mintAmount
        timestamp_
      }
    }
  ` : `
    query LiquidityQuery {
      removeLiquidities(
        skip: ${skipPage},
        first: ${PAGE_SIZE},
        where: { block_number_lte: ${blockNumber} },
      ) {
        id
        account
        token
        amountOut
        llpAmount
        timestamp_
      }
    }
  `;

  try {
    const responseJson = await post(LOGX_SUBGRAPH_QUERY_URL, { query });
    if (!responseJson.data) {
      throw new Error(`Unexpected response format: ${JSON.stringify(responseJson)}`);
    }
    return type === 'add' ? responseJson.data.addLiquidities : responseJson.data.removeLiquidities;
  } catch (error) {
    console.error(`Error fetching ${type} liquidities for block ${blockNumber} at skip page ${skipPage}:`, error);
    return [];
  }
};

const aggregateData = async (blockNumber: number, type: 'add' | 'remove'): Promise<any[]> => {
  let skipPage = 0;
  let allData: any[] = [];

  while (true) {
    const data = await getLiquidityData(blockNumber, skipPage, type);
    allData = allData.concat(data);
    if (data.length < PAGE_SIZE) {
      break;
    }
    skipPage += PAGE_SIZE;
  }

  return allData;
};

const getUserTVLByBlock = async (block: BlockData) => {
  const { blockNumber, blockTimestamp } = block;
  const llpPrice = await getLlpPrice();
  const llpPriceBigInt = BigInt(Math.floor(llpPrice * 10**6)); // Convert llpPrice to BigInt in 6 decimal places
  const accountBalances: { [key: string]: bigint } = {};

  const addLiquidities = await aggregateData(blockNumber, 'add');
  const removeLiquidities = await aggregateData(blockNumber, 'remove');

  // console.log('Add Liquidities:', addLiquidities);
  // console.log('Remove Liquidities:', removeLiquidities);

  addLiquidities.forEach((item: any) => {
    accountBalances[item.account] = (accountBalances[item.account] || BigInt(0)) + BigInt(item.mintAmount);
  });

  removeLiquidities.forEach((item: any) => {
    accountBalances[item.account] = (accountBalances[item.account] || BigInt(0)) - BigInt(item.llpAmount);
  });

  // console.log('Account Balances:', accountBalances);

  const csvRows: OutputDataSchemaRow[] = Object.keys(accountBalances)
    .filter(account => accountBalances[account] > BigInt(0))  // Filter out zero or negative balances
    .map(account => {
      const balanceInUsdc = (accountBalances[account] * llpPriceBigInt) / BigInt(10**18);
      return {
        block_number: blockNumber,
        timestamp: blockTimestamp,
        user_address: account,
        token_address: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff',  // Placeholder as token_address is not provided in this context
        token_balance: balanceInUsdc,
        token_symbol: 'USDC',  // Should be an empty string if not available
        usd_price: 0 // Assign 0 if not available
      };
    });

  return csvRows;
};

const readBlocksFromCSV = async (filePath: string): Promise<BlockData[]> => {
  const blocks: BlockData[] = [];
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(parse({ headers: true }))
      .on('error', error => reject(error))
      .on('data', (row: any) => {
        const blockNumber = parseInt(row.number, 10);
        const blockTimestamp = parseInt(row.timestamp, 10);
        if (!isNaN(blockNumber) && blockTimestamp) {
          blocks.push({ blockNumber, blockTimestamp });
        }
      })
      .on('end', () => resolve(blocks));
  });
};

const fetchAndWriteToCsv = async (filePath: string, blocks: BlockData[]) => {
  const allCsvRows: OutputDataSchemaRow[] = [];

  for (const block of blocks) {
    const result = await getUserTVLByBlock(block);
    allCsvRows.push(...result);
  }

  let fileExists = fs.existsSync(filePath);
  let fileEmpty = true;

  if (fileExists) {
    const stats = fs.statSync(filePath);
    fileEmpty = stats.size === 0;
  }

  const ws = fs.createWriteStream(filePath, { flags: 'a' });

  writeToStream(ws, allCsvRows, { headers: fileEmpty, includeEndRowDelimiter: true })
    .on('finish', () => {
      console.log(`CSV file '${filePath}' has been written successfully.`);
    });
};

const inputFilePath = 'hourly_blocks.csv';
const outputFilePath = 'outputData.csv';

readBlocksFromCSV(inputFilePath).then(async (blocks) => {
  await fetchAndWriteToCsv(outputFilePath, blocks);
}).catch((err) => {
  console.error('Error reading CSV file:', err);
});
