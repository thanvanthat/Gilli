print("====================================")
print("         KITTI PULL GAME")
print("====================================")

scoreA = 0
scoreB = 0

# ---------- TOSS ----------
toss = input("Who won the toss? (A/B): ").strip().upper()
while toss != "A" and toss != "B":
    print("Please enter A or B.")
    toss = input("Who won the toss? (A/B): ").strip().upper()

choice = input("Team " + toss + " choose bat or field: ").strip().lower()
while choice != "bat" and choice != "field":
    print("Please enter bat or field.")
    choice = input("Team " + toss + " choose bat or field: ").strip().lower()

if toss == "A" and choice == "bat":
    order = ["Team A", "Team B"]
elif toss == "A" and choice == "field":
    order = ["Team B", "Team A"]
elif toss == "B" and choice == "bat":
    order = ["Team B", "Team A"]
else:
    order = ["Team A", "Team B"]

# ---------- GAME ----------
for team in order:
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

            hit = input("Did you hit the gilli? (yes/no): ").strip().lower()
            while hit != "yes" and hit != "no":
                print("Please enter yes or no.")
                hit = input("Did you hit the gilli? (yes/no): ").strip().lower()

            if hit == "no":
                misses += 1
                print("Missed! No score.")
                print("Consecutive misses:", misses)
                if misses == 3:
                    print("3 consecutive misses - OUT!")
                    out = True

            else:
                print("Gilli hit!")
                caught = input("Did the fielder catch it? (yes/no): ").strip().lower()
                while caught != "yes" and caught != "no":
                    print("Please enter yes or no.")
                    caught = input("Did the fielder catch it? (yes/no): ").strip().lower()

                if caught == "yes":
                    print("Caught - OUT!")
                    out = True

                else:
                    throw = input("Did the fielder hit the danda? (yes/no): ").strip().lower()
                    while throw != "yes" and throw != "no":
                        print("Please enter yes or no.")
                        throw = input("Did the fielder hit the danda? (yes/no): ").strip().lower()

                    if throw == "yes":
                        print("Danda hit - OUT!")
                        out = True

                    else:
                        print("Safe! Fielder missed.")

                        danda = input("Enter danda length in metres: ").strip()
                        while not danda.isdigit() or int(danda) == 0:
                            print("Please enter a number greater than 0.")
                            danda = input("Enter danda length in metres: ").strip()
                        danda = int(danda)

                        distance = input("Enter gilli distance in metres: ").strip()
                        while not distance.isdigit() or int(distance) == 0:
                            print("Please enter a number greater than 0.")
                            distance = input("Enter gilli distance in metres: ").strip()
                        distance = int(distance)

                        distance_points = distance // danda
                        score += distance_points + 1

                        print("\nGilli travelled:", distance, "metres")
                        print("Distance points:", distance_points)
                        print("Safe-hit bonus: 1")
                        print("Current score:", score)
                        print("Player gets another chance.")

                        misses = 0   # successful hit resets misses

            attempt += 1

    if team == "Team A":
        scoreA = score
    else:
        scoreB = score

# ---------- FINAL RESULT ----------
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
