// mongo.js
const { MongoClient } = require('mongodb');
require('dotenv').config();

const uri = process.env.MONGO_URI || 'mongodb://localhost:27017';
const client = new MongoClient(uri);

let dbInstance = null;

async function connectMongo() {
  if (!dbInstance) {
    await client.connect();
    dbInstance = client.db('movieweb');
    console.log('Conectado exitosamente a MongoDB');
  }
  return dbInstance;
}

module.exports = { connectMongo };