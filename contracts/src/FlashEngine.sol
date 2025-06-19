// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IPancakeRouter {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
    
    function swapExactETHForTokens(
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external payable returns (uint[] memory amounts);
    
    function swapExactTokensForETH(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
    
    function getAmountsOut(uint amountIn, address[] calldata path)
        external view returns (uint[] memory amounts);
}

// Venus Protocol Interfaces
interface IVToken {
    function mint(uint mintAmount) external returns (uint);
    function redeem(uint redeemTokens) external returns (uint);
    function redeemUnderlying(uint redeemAmount) external returns (uint);
    function borrow(uint borrowAmount) external returns (uint);
    function repayBorrow(uint repayAmount) external returns (uint);
    function borrowBalanceCurrent(address account) external returns (uint);
    function getAccountSnapshot(address account) external view returns (uint, uint, uint, uint);
}

interface IUnitroller {
    function enterMarkets(address[] calldata vTokens) external returns (uint[] memory);
    function exitMarket(address vToken) external returns (uint);
    function getAccountLiquidity(address account) external view returns (uint, uint, uint);
}

/**
 * @title FlashEngine for BSC
 * @dev Optimized flash loan engine for MEV extraction on Binance Smart Chain
 */
contract FlashEngine is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    
    // Fee configuration
    uint256 public constant PLATFORM_FEE_BPS = 2000; // 20%
    address public immutable platformWallet;
    
    // Venus Protocol addresses
    address public constant UNITROLLER = 0xfD36E2c2a6789Db23113685031d7F16329158384;
    address public constant VBNB = 0xA07c5b74C9B40447a954e1466938b865b6BBea36;
    
    // Gas optimization: Pack struct
    struct FlashParams {
        address asset;
        uint256 amount;
        address[] routers;
        bytes routerCalldata;
        uint256 minProfit;
        bool useVenus; // Whether to use Venus for flash loan
    }
    
    // Events
    event FlashLoanExecuted(
        address indexed initiator,
        address indexed asset,
        uint256 amount,
        uint256 profit,
        uint256 platformFee
    );
    
    event EmergencyWithdraw(address indexed token, uint256 amount);
    
    // Modifiers
    modifier onlyOperator() {
        require(hasRole(OPERATOR_ROLE, msg.sender), "Not operator");
        _;
    }
    
    constructor(address _platformWallet) {
        require(_platformWallet != address(0), "Invalid platform wallet");
        platformWallet = _platformWallet;
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
    }
    
    /**
     * @dev Initiates a flash loan for MEV extraction using Venus Protocol
     */
    function executeFlashLoan(
        FlashParams calldata params
    ) external onlyOperator whenNotPaused nonReentrant {
        require(params.amount > 0, "Invalid amount");
        require(params.asset != address(0), "Invalid asset");
        
        if (params.useVenus) {
            _executeVenusFlashLoan(params);
        } else {
            // For simple arbitrage without flash loans
            _executeDirectArbitrage(params);
        }
    }
    
    /**
     * @dev Executes flash loan using Venus Protocol
     */
    function _executeVenusFlashLoan(FlashParams memory params) private {
        // Enter Venus market
        address[] memory markets = new address[](1);
        markets[0] = params.asset == address(0) ? VBNB : params.asset; // Use vBNB for BNB
        IUnitroller(UNITROLLER).enterMarkets(markets);
        
        // Get vToken address (would need mapping in production)
        IVToken vToken = IVToken(markets[0]);
        
        // Borrow assets
        uint256 borrowResult = vToken.borrow(params.amount);
        require(borrowResult == 0, "Borrow failed");
        
        // Execute arbitrage strategy
        uint256 profit = _executeStrategy(params);
        
        // Calculate repayment
        uint256 borrowBalance = vToken.borrowBalanceCurrent(address(this));
        require(profit > borrowBalance - params.amount, "Insufficient profit");
        
        // Repay loan
        if (params.asset == address(0)) {
            // Repay BNB
            uint256 repayResult = vToken.repayBorrow{value: borrowBalance}(borrowBalance);
            require(repayResult == 0, "Repay failed");
        } else {
            // Repay token
            IERC20(params.asset).approve(address(vToken), borrowBalance);
            uint256 repayResult = vToken.repayBorrow(borrowBalance);
            require(repayResult == 0, "Repay failed");
        }
        
        // Distribute profits
        _distributeProfit(params.asset, profit - (borrowBalance - params.amount));
    }
    
    /**
     * @dev Execute direct arbitrage without flash loan
     */
    function _executeDirectArbitrage(FlashParams memory params) private {
        uint256 initialBalance = params.asset == address(0) 
            ? address(this).balance 
            : IERC20(params.asset).balanceOf(address(this));
            
        uint256 finalBalance = _executeStrategy(params);
        
        require(finalBalance > initialBalance, "No profit");
        
        _distributeProfit(params.asset, finalBalance - initialBalance);
    }
    
    /**
     * @dev Executes the arbitrage strategy
     */
    function _executeStrategy(
        FlashParams memory params
    ) private returns (uint256) {
        // Execute router calls (PancakeSwap, etc)
        if (params.asset != address(0)) {
            IERC20(params.asset).approve(params.routers[0], params.amount);
        }
        
        uint256 value = params.asset == address(0) ? params.amount : 0;
        (bool success,) = params.routers[0].call{value: value}(params.routerCalldata);
        require(success, "Strategy execution failed");
        
        // Return final balance
        return params.asset == address(0) 
            ? address(this).balance 
            : IERC20(params.asset).balanceOf(address(this));
    }
    
    /**
     * @dev Distributes profit between platform and operator
     */
    function _distributeProfit(address asset, uint256 profit) private {
        require(profit > 0, "No profit to distribute");
        
        uint256 platformFee = (profit * PLATFORM_FEE_BPS) / 10000;
        uint256 operatorProfit = profit - platformFee;
        
        if (asset == address(0)) {
            // Transfer BNB
            if (platformFee > 0) {
                (bool success1,) = platformWallet.call{value: platformFee}("");
                require(success1, "Platform fee transfer failed");
            }
            
            if (operatorProfit > 0) {
                (bool success2,) = tx.origin.call{value: operatorProfit}("");
                require(success2, "Operator profit transfer failed");
            }
        } else {
            // Transfer tokens
            if (platformFee > 0) {
                IERC20(asset).transfer(platformWallet, platformFee);
            }
            
            if (operatorProfit > 0) {
                IERC20(asset).transfer(tx.origin, operatorProfit);
            }
        }
        
        emit FlashLoanExecuted(
            tx.origin,
            asset,
            profit + platformFee,
            profit,
            platformFee
        );
    }
    
    /**
     * @dev Simulates arbitrage opportunity for gas estimation
     */
    function simulateArbitrage(
        FlashParams calldata params
    ) external view returns (uint256 expectedProfit, uint256 gasEstimate) {
        // This would contain simulation logic
        // For now, return placeholder values
        expectedProfit = params.minProfit * 2;
        gasEstimate = 400000; // Higher for BSC complex operations
    }
    
    /**
     * @dev Multi-DEX arbitrage execution
     */
    function executeMultiDexArbitrage(
        address tokenA,
        address tokenB,
        uint256 amountIn,
        address[] calldata routers,
        bytes[] calldata routerCalldata
    ) external onlyOperator whenNotPaused nonReentrant {
        require(routers.length == routerCalldata.length, "Mismatched arrays");
        require(routers.length >= 2, "Need at least 2 routers");
        
        // Record initial balance
        uint256 initialBalance = IERC20(tokenA).balanceOf(address(this));
        require(initialBalance >= amountIn, "Insufficient balance");
        
        // Execute trades across DEXs
        for (uint i = 0; i < routers.length; i++) {
            address currentToken = i % 2 == 0 ? tokenA : tokenB;
            uint256 amount = IERC20(currentToken).balanceOf(address(this));
            
            IERC20(currentToken).approve(routers[i], amount);
            
            (bool success,) = routers[i].call(routerCalldata[i]);
            require(success, "DEX trade failed");
        }
        
        // Check profit
        uint256 finalBalance = IERC20(tokenA).balanceOf(address(this));
        require(finalBalance > initialBalance, "No profit");
        
        _distributeProfit(tokenA, finalBalance - initialBalance);
    }
    
    /**
     * @dev Emergency functions
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }
    
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
    
    function emergencyWithdraw(
        address token
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) {
            uint256 balance = address(this).balance;
            if (balance > 0) {
                (bool success,) = msg.sender.call{value: balance}("");
                require(success, "BNB transfer failed");
                emit EmergencyWithdraw(token, balance);
            }
        } else {
            uint256 balance = IERC20(token).balanceOf(address(this));
            if (balance > 0) {
                IERC20(token).transfer(msg.sender, balance);
                emit EmergencyWithdraw(token, balance);
            }
        }
    }
    
    // Receive BNB
    receive() external payable {}
}