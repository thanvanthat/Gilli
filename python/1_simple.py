a = 0
b = 0

print("===== KITTI PULL GAME =====")

for i in range(3):
    hit = input("Team A hit the gilli? (yes/no): ")
    if hit == "yes":
        a += int(input("Enter distance: "))
    else:
        print("Missed!")

for i in range(3):
    hit = input("Team B hit the gilli? (yes/no): ")
    if hit == "yes":
        b += int(input("Enter distance: "))
    else:
        print("Missed!")

while a == b:
    print("Draw! Extra chance for both teams.")
    a += int(input("Team A extra distance: "))
    b += int(input("Team B extra distance: "))

print("Team A:", a)
print("Team B:", b)

if a > b:
    print("Team A Wins!")
else:
    print("Team B Wins!")
