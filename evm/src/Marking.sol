// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Marking — Bitmark's "currency for giving", on-chain.
/// @notice "Mark" someone: send wBTMK with a reason. Each mark is recorded as a
///         structured, queryable gift — the social graph Bitmark L1's plain
///         payments can't express. `identity` lets you mark a did:nostr / npub /
///         name, not just an address.
interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract Marking {
    IERC20 public immutable token; // wBTMK

    uint256 public totalMarks;
    mapping(address => uint256) public received; // wBTMK received as marks (leaderboard)
    mapping(address => uint256) public given;    // wBTMK given as marks
    mapping(address => uint256) public timesMarked;

    event Marked(
        address indexed from,
        address indexed to,
        uint256 amount,
        string identity,
        string reason,
        uint256 index
    );

    constructor(address _token) {
        token = IERC20(_token);
    }

    /// @param to       recipient (receives the wBTMK directly)
    /// @param amount   wBTMK to give
    /// @param identity optional tag for the recipient (did:nostr / npub / name)
    /// @param reason   why you're marking them
    function mark(address to, uint256 amount, string calldata identity, string calldata reason) external {
        require(to != address(0), "Marking: zero recipient");
        require(amount > 0, "Marking: zero amount");
        require(token.transferFrom(msg.sender, to, amount), "Marking: transfer failed");
        received[to] += amount;
        given[msg.sender] += amount;
        timesMarked[to] += 1;
        emit Marked(msg.sender, to, amount, identity, reason, totalMarks);
        totalMarks += 1;
    }
}
