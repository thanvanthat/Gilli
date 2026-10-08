def get_yes_no(question):
    while True:
        answer = input(question).strip().lower()

        if answer == "yes":
            return "yes"
        elif answer == "no":
            return "no"
        else:
            print("Please enter yes or no.")


def get_positive_number(question):
    while True:
        try:
            value = int(input(question))

            if value > 0:
                return value
            else:
                print("Please enter a number greater than 0.")

        except ValueError:
            print("Please enter a valid number.")


def play_team(team):
    score = 0

    print("\n---", team, "Batting ---")

    # 2 players in each team
    for player in range(2):
        print("\nPlayer", player + 1)

        misses = 0
        out = False
        attempt = 1

        # Continue until 3 consecutive misses or OUT
        while misses < 3 and out == False:
            print("\nAttempt", attempt)

            hit = get_yes_no(
                "Did you hit the gilli? (yes/no): "
            )

            # Player missed
            if hit == "no":
                misses += 1

                print("Missed! No score.")
                print("Consecutive misses:", misses)

                if misses == 3:
                    print("3 consecutive misses - OUT!")
                    out = True

            # Player hit the gilli
            elif hit == "yes":
                print("Gilli hit!")

                caught = get_yes_no(
                    "Did the fielder catch it? (yes/no): "
                )

                # Catch = OUT
                if caught == "yes":
                    print("Caught - OUT!")
                    out = True

                # Not caught
                elif caught == "no":
                    throw = get_yes_no(
                        "Did the fielder hit the danda? (yes/no): "
                    )

                    # Danda hit = OUT
                    if throw == "yes":
                        print("Danda hit - OUT!")
                        out = True

                    # Fielder missed
                    elif throw == "no":
                        print("Safe! Fielder missed.")

                        # Get valid danda length
                        danda = get_positive_number(
                            "Enter danda length in metres: "
                        )

                        # Get valid gilli distance
                        distance = get_positive_number(
                            "Enter gilli distance in metres: "
                        )

                        # Calculate points
                        distance_points = distance // danda
                        score += distance_points + 1

                        print("\nGilli travelled:",
                              distance, "metres")
                        print("Distance points:",
                              distance_points)
                        print("Safe-hit bonus: 1")
                        print("Current score:", score)

                        print("Player gets another chance.")

                        # Successful hit resets consecutive misses
                        misses = 0

            attempt += 1

    return score


# ================= MAIN GAME =================

print("====================================")
print("         KITTI PULL GAME")
print("====================================")

# Toss
toss = input("Who won the toss? (A/B): ").strip().upper()

if toss == "A":

    choice = input(
        "Team A choose bat or field: "
    ).strip().lower()

    if choice == "bat":
        first = "A"

    elif choice == "field":
        first = "B"

    else:
        print("Invalid choice. Game ended.")
        raise SystemExit

elif toss == "B":

    choice = input(
        "Team B choose bat or field: "
    ).strip().lower()

    if choice == "bat":
        first = "B"

    elif choice == "field":
        first = "A"

    else:
        print("Invalid choice. Game ended.")
        raise SystemExit

else:
    print("Invalid toss. Game ended.")
    raise SystemExit


# ================= GAME =================

if first == "A":
    scoreA = play_team("Team A")
    scoreB = play_team("Team B")

else:
    scoreB = play_team("Team B")
    scoreA = play_team("Team A")


# ================= FINAL RESULT =================

print("\n====================================")
print("            FINAL SCORE")
print("====================================")

print("Team A:", scoreA)
print("Team B:", scoreB)

if scoreA > scoreB:
    print("Team A Wins!")

elif scoreB > scoreA:
    print("Team B Wins!")

else:
    print("Match Draw!")