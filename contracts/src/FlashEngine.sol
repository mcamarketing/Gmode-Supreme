// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
    
    function getAmountsOut(uint amountIn, address[] calldata path)
        external view returns (uint[] memory amounts);
}

/**
 * @title FlashEngine
 * @dev Optimized flash loan engine for MEV extraction
 */
contract FlashEngine is FlashLoanSimpleReceiverBase, AccessControl, Pausable {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    
    // Fee configuration
    uint256 public constant PLATFORM_FEE_BPS = 2000; // 20%
    address public immutable platformWallet;
    
    // Gas optimization: Pack struct
    struct FlashParams {
        address asset;
        uint256 amount;
        address[] routers;
        bytes routerCalldata;
        uint256 minProfit;
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
    
    constructor(
        address _addressProvider,
        address _platformWallet
    ) FlashLoanSimpleReceiverBase(IPoolAddressesProvider(_addressProvider)) {
        require(_platformWallet != address(0), "Invalid platform wallet");
        platformWallet = _platformWallet;
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
    }
    
    /**
     * @dev Initiates a flash loan for MEV extraction
     */
    function executeFlashLoan(
        FlashParams calldata params
    ) external onlyOperator whenNotPaused {
        require(params.amount > 0, "Invalid amount");
        require(params.asset != address(0), "Invalid asset");
        
        bytes memory data = abi.encode(params);
        
        // Request flash loan
        POOL.flashLoanSimple(
            address(this),
            params.asset,
            params.amount,
            data,
            0 // referral code
        );
    }
    
    /**
     * @dev Flash loan callback - executes arbitrage logic
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Invalid caller");
        require(initiator == address(this), "Invalid initiator");
        
        // Decode parameters
        FlashParams memory flashParams = abi.decode(params, (FlashParams));
        
        // Record initial balance
        uint256 initialBalance = IERC20(asset).balanceOf(address(this));
        
        // Execute arbitrage strategy
        uint256 finalBalance = _executeStrategy(flashParams);
        
        // Calculate profit
        uint256 totalDebt = amount + premium;
        require(finalBalance >= totalDebt, "Insufficient funds to repay");
        
        uint256 profit = finalBalance - totalDebt;
        require(profit >= flashParams.minProfit, "Profit below minimum");
        
        // Distribute profits
        uint256 platformFee = (profit * PLATFORM_FEE_BPS) / 10000;
        uint256 operatorProfit = profit - platformFee;
        
        // Transfer platform fee
        if (platformFee > 0) {
            IERC20(asset).transfer(platformWallet, platformFee);
        }
        
        // Transfer operator profit
        if (operatorProfit > 0) {
            IERC20(asset).transfer(tx.origin, operatorProfit);
        }
        
        // Approve repayment
        IERC20(asset).approve(address(POOL), totalDebt);
        
        emit FlashLoanExecuted(
            tx.origin,
            asset,
            amount,
            profit,
            platformFee
        );
        
        return true;
    }
    
    /**
     * @dev Executes the arbitrage strategy
     */
    function _executeStrategy(
        FlashParams memory params
    ) private returns (uint256) {
        // Approve routers
        IERC20(params.asset).approve(params.routers[0], params.amount);
        
        // Execute router calls
        (bool success,) = params.routers[0].call(params.routerCalldata);
        require(success, "Strategy execution failed");
        
        // Return final balance
        return IERC20(params.asset).balanceOf(address(this));
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
        gasEstimate = 300000;
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
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).transfer(msg.sender, balance);
            emit EmergencyWithdraw(token, balance);
        }
    }
    
    /**
     * @dev Rescue ETH sent to contract
     */
    function rescueETH() external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success,) = msg.sender.call{value: balance}("");
            require(success, "ETH transfer failed");
        }
    }
    
    // Receive ETH
    receive() external payable {}
}