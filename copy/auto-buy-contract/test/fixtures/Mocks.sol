// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockCurve {
    address public immutable factory;
    address public immutable token;
    address public pairToken;
    uint16 public feeBps = 100;
    uint16 public creatorTaxBps = 100;
    uint256 public reservedTokens;
    bool public graduated;
    bool public readyToGraduate;
    uint256 public quoteReserve = 10 ether;
    uint256 public tokenReserve = 1_000_000 ether;

    constructor(address factory_, address token_) { factory = factory_; token = token_; }
    function setGraduated(bool value) external { graduated = value; }
    function setPairToken(address value) external { pairToken = value; }
    function getReserves() external view returns (uint256, uint256) { return (quoteReserve, tokenReserve); }
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable {
        require(msg.value == quoteIn, "value");
        uint256 net = quoteIn * (10_000 - feeBps - creatorTaxBps) / 10_000;
        uint256 output = net * tokenReserve / (quoteReserve + net);
        require(output >= minTokensOut, "slippage");
        MockToken(token).transfer(recipient, output);
        quoteReserve += net;
        tokenReserve -= output;
    }
}

contract MockFactory {
    struct Launch { address token; address curve; address pairToken; uint8 phase; bool exists; }
    mapping(address => Launch) public launches;
    function setLaunch(address token, address curve, address pairToken, uint8 phase, bool exists) external {
        launches[token] = Launch(token, curve, pairToken, phase, exists);
    }
    function getLaunchedToken(address token) external view returns (
        address, address, address, address, address, uint256, uint24, int24, uint16, bool, uint8, uint256, uint256, uint64, bool
    ) {
        Launch memory item = launches[token];
        return (item.token, item.curve, address(1), address(2), item.pairToken, 0, 0, 0, 0, false, item.phase, 0, 0, 0, item.exists);
    }
}
