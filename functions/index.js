const functions = require('firebase-functions');
const axios = require('axios');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers/out');
const {
    Address,
    ResultsParser,
    SmartContract,
    AbiRegistry
} = require('@multiversx/sdk-core/out');

const abiFile = require('./dualstake.abi.json');

const chainID = "D";
let contractAddress = "erd1qqqqqqqqqqqqqpgq5k55q4tsrxa7f6rxwuk5rtzkva4m527svcqsp0p7h2";
let gatewayURL = "https://devnet-gateway.multiversx.com";
const abiRegistry = AbiRegistry.create(abiFile)

//PROD VERSION
if (chainID === 1) {
    contractAddress = "";
    gatewayURL = "https://elrond-proxy.staking.agency/";
}

const networkProvider = new ProxyNetworkProvider(gatewayURL, { timeout: 10000 });
const dynamicStakingContractAddress = new Address(contractAddress);
const dynamicStakingSmartContract = new SmartContract({
    address: dynamicStakingContractAddress,
    abi: abiRegistry
});

const getPools = async () => {
    try {
        const interaction = dynamicStakingSmartContract.methods.getStakes([]);
        const query = interaction.check().buildQuery();
        const queryResponse = await networkProvider.queryContract(query);
        const typedBundle = new ResultsParser().parseQueryResponse(queryResponse, interaction.getEndpoint());
        const result = typedBundle.values[0].valueOf();
        console.log(result);

        return result;
    } catch (err) {
        console.log(`Error getPools: ${err}`);
        return 0;
    }
};

getPools();

exports.calculateAPR = functions.pubsub.schedule('* * * * *').timeZone('UTC').onRun(async (context) => {
    // Your code to interact with the DEX and calculate the APR for farms
    try {
        const response = await axios.get('https://api.dex.com/farms');
        const farms = response.data;
        // Assume APR can be calculated as: (rewardRate / stakedAmount) * 365 * 100
        const aprs = farms.map(farm => (farm.rewardRate / farm.stakedAmount) * 365 * 100);
        console.log(aprs);
    } catch (error) {
        console.error(error);
    }
});
