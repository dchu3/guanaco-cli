#!/bin/bash

# Allowlist of permitted commands
ALLOWED_COMMANDS=("ls" "pwd" "echo" "cat" "whoami" "date" "uptime" "df" "free" "ps" "ollama")

# Function to check if a command is in the allowlist
is_allowed() {
    local cmd=$1
    for allowed in "${ALLOWED_COMMANDS[@]}"; do
        if [[ "$cmd" == "$allowed" ]]; then
            return 0
        fi
    done
    return 1
}

# The user-provided command string is the first argument
FULL_COMMAND="$1"

if [[ -z "$FULL_COMMAND" ]]; then
    echo "Error: No command provided."
    exit 1
fi

# Extract the base command (first word)
BASE_CMD=$(echo "$FULL_COMMAND" | awk '{print $1}')

# Validate base command against allowlist
if is_allowed "$BASE_CMD"; then
    # Security: Avoid using 'eval' on raw input to prevent command chaining (e.g. "ls; rm -rf /")
    # Instead, we execute the command by splitting it into arguments.
    # We use 'bash -c' here but it is slightly risky if we don't strictly control the input.
    # Given the constraint to use an allowlist, we will run the command as a single execution.
    
    # Check for shell metacharacters that could be used for injection
    if [[ "$FULL_COMMAND" =~ [";"\|\&\|\>\|\<] ]]; then
        echo "Error: Command contains forbidden characters (; & | > <)."
        exit 1
    fi

    # Security: Explicitly forbid access to .env files
    if [[ "$FULL_COMMAND" == *".env"* ]]; then
        echo "Error: Access to .env files is forbidden."
        exit 1
    fi

    # Security: Validate ollama subcommands
    if [[ "$BASE_CMD" == "ollama" ]]; then
        SUB_CMD=$(echo "$FULL_COMMAND" | awk '{print $2}')
        SAFE_OLLAMA_CMDS=("list" "ps" "show" "help" "run")
        is_safe_ollama=1
        for safe in "${SAFE_OLLAMA_CMDS[@]}"; do
            if [[ "$SUB_CMD" == "$safe" ]]; then
                is_safe_ollama=0
                break
            fi
        done
        if [[ $is_safe_ollama -eq 1 ]]; then
            echo "Error: ollama subcommand '$SUB_CMD' is not allowed."
            exit 1
        fi
    fi

    # Execute and capture output
    exec $FULL_COMMAND 2>&1
else
    echo "Error: Command '$BASE_CMD' is not allowed."
    exit 1
fi
