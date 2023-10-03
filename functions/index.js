const functions = require('firebase-functions');
const axios = require('axios');
const admin = require('firebase-admin');

const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers/out');
const {
    Address,
    ResultsParser,
    SmartContract,
    AbiRegistry,
    U32Value
} = require('@multiversx/sdk-core/out');

const app = express();
admin.initializeApp();

app.use(cors({ origin: true }));

app.get('/aprs', async (req, res) => {
    try {
        const aprs = await db.collection('aprCache').get();

        const aprData = [];
        aprs.forEach(doc => {
            aprData.push({ pool_id: doc.id, ...doc.data() });
        });

        res.status(200).send(aprData);
    } catch (error) {
        console.error('Error fetching APRs:', error);
        res.status(500).send('Internal Server Error');
    }
});


const db = admin.firestore();
const abiFile = require('./dualstake.abi.json');
const abiRegistry = AbiRegistry.create(abiFile)

const chainID = "D";
let contractAddress = "erd1qqqqqqqqqqqqqpgq5k55q4tsrxa7f6rxwuk5rtzkva4m527svcqsp0p7h2";
let gatewayURL = "https://devnet-gateway.multiversx.com";
let pricesURL = "https://api.onedex.app/prices";

//PROD VERSION
if (chainID === 1) {
    contractAddress = "";
    gatewayURL = "https://elrond-proxy.staking.agency/";
    pricesURL = "https://api.onedex.app/prices";
}

const networkProvider = new ProxyNetworkProvider(gatewayURL, { timeout: 10000 });
const dynamicStakingContractAddress = new Address(contractAddress);
const dynamicStakingSmartContract = new SmartContract({
    address: dynamicStakingContractAddress,
    abi: abiRegistry
});

const MAX_RETRIES = 3;
const RETRY_DELAY = 500;  // milliseconds
const ROUNDS_PER_DAY = 14400;

const processAPRCalculation = async () => {
    const pools = await getActivePools();
    const prices = await fetchPrices();

    if (!prices) {
        console.log('Failed to fetch prices');
        return;
    }

    for (const pool of pools) {
        try {
            const checkpoint = await getLastCheckpoint(pool.stake_id);

            if (!checkpoint) {
                console.log(`Failed to fetch checkpoint for pool ${pool.stake_id}`);
                return;
            }

            const tokensSet = new Set([...pool.stake_tokens, ...pool.reward_tokens]);
            const uniqueTokens = Array.from(tokensSet);
            const tokenDecimals = await fetchTokenDecimals(uniqueTokens);
            if (!tokenDecimals) {
                console.log(`Failed to fetch token decimals for pool ${pool.stake_id}`);
                return;
            }

            const poolDays = (Number(checkpoint.end_nonce) - Number(checkpoint.start_nonce)) / ROUNDS_PER_DAY;

            const totalStakedValue = calculateValue(checkpoint.staked, prices, pool.stake_tokens, tokenDecimals);
            if (totalStakedValue === 0) {
                return;
            }

            const totalRewardsValue = calculateValue(checkpoint.rewards, prices, pool.reward_tokens, tokenDecimals);

            const dailyRewardRate = totalRewardsValue / poolDays;
            const APR = (dailyRewardRate / totalStakedValue) * 365 * 100;

            // Update the cache in Firestore
            const poolRef = db.collection('aprCache').doc(String(pool.stake_id));
            await poolRef.set({ apr: APR });

            console.log(`Pool ${pool.stake_id} APR: ${APR}%`);
        }
        catch (err) {
            console.log(`Error processing pool ${pool.stake_id}: ${err}`);
        }
    };
};

const getLastCheckpoint = async (poolId, retryCount = 0) => {
    try {
        const interaction = dynamicStakingSmartContract.methods.getLastCheckpoint([new U32Value(Number(poolId))]);
        const query = interaction.check().buildQuery();
        const queryResponse = await networkProvider.queryContract(query);
        const typedBundle = new ResultsParser().parseQueryResponse(queryResponse, interaction.getEndpoint());
        const checkpoint = typedBundle.values[0].valueOf();
        console.log(checkpoint);

        return checkpoint;
    } catch (err) {
        console.log(`Error getLastCheckpoint: ${err}`);
        if (retryCount < MAX_RETRIES) {
            console.log(`Retrying... (${retryCount + 1}/${MAX_RETRIES}) for pool ${Number(poolId)}`);
            // Wait for a bit before retrying
            await new Promise(res => setTimeout(res, RETRY_DELAY));
            return getLastCheckpoint(poolId, retryCount + 1);
        } else {
            console.log(`Max retries reached. Aborting. ${Number(poolId)}`);
            return null;
        }
    }
};

const getNetworkStatus = async () => {
    const networkStatus = await networkProvider.getNetworkStatus();
    const blockNonce = networkStatus.HighestFinalNonce;

    return blockNonce;
};

const getActivePools = async () => {
    try {
        const pools = await getPools();
        if (!pools)
            throw new Error('No pools found');

        return pools.filter(stake => stake.state.name === 'Active');;
    } catch (err) {
        console.log(`Error getActivePools: ${err}`);
        return null;
    }
};

const getPools = async () => {
    try {
        const interaction = dynamicStakingSmartContract.methods.getStakes([]);
        const query = interaction.check().buildQuery();
        const queryResponse = await networkProvider.queryContract(query);
        const typedBundle = new ResultsParser().parseQueryResponse(queryResponse, interaction.getEndpoint());
        const result = typedBundle.values[0].valueOf();

        return result;
    } catch (err) {
        console.log(`Error getPools: ${err}`);
        return null;
    }
};

const fetchPrices = async () => {
    try {
        const response = await axios.get(pricesURL);
        return response.data;
    } catch (err) {
        console.log(`Error fetchPrices: ${err}`);
        return null;
    }
};

const calculateValue = (amounts, prices, tokens, tokenDecimals) => {
    let totalValue = 0;
    for (let i = 0; i < amounts.length; i++) {
        const token = tokens[i];

        if (!prices[token]) {
            console.log(`Price not found for token: ${token}`);
            continue;
        }

        const decimalFactor = Math.pow(10, tokenDecimals[token] || 18);
        const amount = Number(amounts[i]) / decimalFactor;
        const price = prices[token].priceUsdc;
        totalValue += amount * price;
    }

    return totalValue;
};

const fetchTokenDecimals = async (tokens) => {
    try {
        const response = await axios.get(`https://devnet-api.multiversx.com/tokens?identifiers=${tokens.join(',')}`);
        const data = response.data;
        const decimalsMap = {};
        data.forEach(tokenInfo => {
            decimalsMap[tokenInfo.identifier] = tokenInfo.decimals;
        });
        return decimalsMap;
    } catch (err) {
        console.error(`Failed to fetch token decimals: ${err}`);
        return null;
    }
};


//startup
processAPRCalculation();

//runs every minute
exports.calculateAPR = functions.pubsub.schedule('* * * * *').timeZone('UTC').onRun(async (context) => {
    try {
        console.log("---------- SCHEDULE START ----------");
        await processAPRCalculation();
        console.log("---------- FINISHED ----------");
    } catch (error) {
        console.error(error);
    }
});

exports.app = functions.region('europe-west1').https.onRequest(app);
