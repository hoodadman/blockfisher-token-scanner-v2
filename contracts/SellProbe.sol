// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Only ever run inside eth_call with a state override: it is never deployed,
// and nothing it does is sent to the chain. It buys a little of a token through
// a Uniswap V2 style router, then sells it straight back, and reports what came
// back each way so the scanner can see blocked sells and real taxes.

interface IRouter {
    function WETH() external view returns (address);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256, address[] calldata, address, uint256) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256, uint256, address[] calldata, address, uint256) external;
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

contract SellProbe {
    receive() external payable {}

    /// @return stage 0 = the buy failed, 1 = bought but the sell failed, 2 = both went through
    function probe(address router, address token)
        external
        payable
        returns (uint8 stage, uint256 buyExpected, uint256 buyReceived, uint256 sellExpected, uint256 sellReceived)
    {
        address wrapped = IRouter(router).WETH();
        address[] memory path = new address[](2);
        path[0] = wrapped;
        path[1] = token;
        buyExpected = IRouter(router).getAmountsOut(msg.value, path)[1];

        try IRouter(router).swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(
            0, path, address(this), block.timestamp
        ) {} catch {
            return (0, buyExpected, 0, 0, 0);
        }
        buyReceived = IERC20(token).balanceOf(address(this));
        if (buyReceived == 0) return (0, buyExpected, 0, 0, 0);

        path[0] = token;
        path[1] = wrapped;
        sellExpected = IRouter(router).getAmountsOut(buyReceived, path)[1];
        // Low-level call: some tokens don't return a bool from approve.
        (bool approved,) = token.call(abi.encodeWithSelector(IERC20.approve.selector, router, buyReceived));
        if (!approved) return (1, buyExpected, buyReceived, sellExpected, 0);

        uint256 before = address(this).balance;
        try IRouter(router).swapExactTokensForETHSupportingFeeOnTransferTokens(
            buyReceived, 0, path, address(this), block.timestamp
        ) {} catch {
            return (1, buyExpected, buyReceived, sellExpected, 0);
        }
        sellReceived = address(this).balance - before;
        return (2, buyExpected, buyReceived, sellExpected, sellReceived);
    }
}
