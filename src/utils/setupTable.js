// Load .env trước khi AWS SDK đọc credentials
require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const { dynamoClient } = require("../config/awsConfig");
const { CreateTableCommand, DescribeTableCommand } = require("@aws-sdk/client-dynamodb");

const TABLE_NAME = "ott_read_receipts";

async function createReadReceiptsTable() {
  console.log(`Checking if table ${TABLE_NAME} exists...`);

  try {
    await dynamoClient.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
    console.log(`Table ${TABLE_NAME} already exists.`);
  } catch (error) {
    if (error.name === "ResourceNotFoundException") {
      console.log(`Table ${TABLE_NAME} not found. Creating...`);

      const params = {
        TableName: TABLE_NAME,
        AttributeDefinitions: [
          { AttributeName: "conversationId", AttributeType: "S" },
          { AttributeName: "messageId", AttributeType: "S" },
          { AttributeName: "userId", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "conversationId", KeyType: "HASH" }, // Partition Key
          { AttributeName: "messageId", KeyType: "RANGE" },    // Sort Key
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "userId-index",
            KeySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
            Projection: { ProjectionType: "ALL" },
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
          },
          {
            IndexName: "conversationId-messageId-index",
            KeySchema: [
              { AttributeName: "conversationId", KeyType: "HASH" },
              { AttributeName: "messageId", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
          },
        ],
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5,
        },
      };

      try {
        await dynamoClient.send(new CreateTableCommand(params));
        console.log(`Table ${TABLE_NAME} is being created. Please wait a minute before testing.`);
      } catch (createError) {
        console.error("Error creating table:", createError.message);
      }
    } else {
      console.error("Error describing table:", error.message);
    }
  }
}

createReadReceiptsTable();
