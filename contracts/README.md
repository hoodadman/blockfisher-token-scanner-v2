# Contracts

`SellProbe.sol` is never deployed. The scanner passes its runtime code to the
node in an `eth_call` state override, so the buy and sell it does happen only in
the simulation. Nothing is sent to the chain.

When you change it, recompile and paste the result into `src/api/sellProbe.ts`:

```
npm i --no-save solc@0.8.28
node -e "const solc=require('solc'),fs=require('fs');const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'SellProbe.sol':{content:fs.readFileSync('contracts/SellProbe.sol','utf8')}},settings:{optimizer:{enabled:true,runs:200},evmVersion:'paris',outputSelection:{'*':{'*':['evm.deployedBytecode.object']}}}})));console.log(out.contracts['SellProbe.sol'].SellProbe.evm.deployedBytecode.object)"
```
