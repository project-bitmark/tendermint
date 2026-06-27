// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Wrapped Bitmark (wBTMK)
/// @notice Minimal ERC-20 representing Bitmark (BTMK) bridged onto the
///         Tendermint/EVM sidechain. For this PoC the peg is STUBBED:
///         a single trusted operator (the contract owner) mints wBTMK when
///         BTMK is "locked" on Bitmark L1, and burns wBTMK on redemption.
///         In production the owner would be replaced by the validator-set
///         threshold signer / a peg module — the rest of the token is unchanged.
contract wBTMK {
    string public constant name = "Wrapped Bitmark";
    string public constant symbol = "wBTMK";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    address public owner; // peg operator (stub for the validator-set custodian)

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    /// @notice Emitted when the peg credits wrapped coins for a locked L1 deposit.
    event PegMint(address indexed to, uint256 value, string btmkTxid);
    /// @notice Emitted when a holder burns wrapped coins to redeem on L1.
    event PegBurn(address indexed from, uint256 value, string btmkAddress);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "wBTMK: not peg operator");
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
    }

    // --- Peg operations (stubbed custody) ---

    /// @notice Credit wBTMK for BTMK locked on Bitmark L1.
    /// @param btmkTxid the L1 lock transaction id (audit trail only in this PoC).
    function pegMint(address to, uint256 value, string calldata btmkTxid) external onlyOwner {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
        emit PegMint(to, value, btmkTxid);
    }

    /// @notice Burn wBTMK to request redemption of BTMK on L1.
    function pegBurn(uint256 value, string calldata btmkAddress) external {
        require(balanceOf[msg.sender] >= value, "wBTMK: insufficient balance");
        balanceOf[msg.sender] -= value;
        totalSupply -= value;
        emit Transfer(msg.sender, address(0), value);
        emit PegBurn(msg.sender, value, btmkAddress);
    }

    function setOwner(address newOwner) external onlyOwner {
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    // --- Standard ERC-20 ---

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "wBTMK: insufficient allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        return _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        require(to != address(0), "wBTMK: transfer to zero");
        require(balanceOf[from] >= value, "wBTMK: insufficient balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}
