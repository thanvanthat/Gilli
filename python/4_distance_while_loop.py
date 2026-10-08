# Kitti Pull - gilli distance calculated with a while loop
# The gilli is moved 0.01 seconds at a time, with gravity pulling it down,
# until it touches the ground. Then the distance is turned into points.

import math

DANDA_LEN = 1.5     # 1 danda length = 1.5 metres
GRAVITY = 9.8
dt = 0.01           # time step in seconds

speed = float(input("Enter hit speed (m/s, e.g. 20): "))
while speed <= 0:
    print("Please enter a speed greater than 0.")
    speed = float(input("Enter hit speed (m/s, e.g. 20): "))

angle_deg = float(input("Enter launch angle (degrees, e.g. 35): "))
while angle_deg <= 0 or angle_deg >= 90:
    print("Please enter an angle between 0 and 90.")
    angle_deg = float(input("Enter launch angle (degrees, e.g. 35): "))

angle = math.radians(angle_deg)
vx = speed * math.cos(angle)
vy = speed * math.sin(angle)

x = 0
y = 0
time = 0

# keep moving until the gilli hits the ground
while y >= 0:
    x = x + vx * dt
    vy = vy - GRAVITY * dt
    y = y + vy * dt
    time = time + dt

distance = x
dandas = int(distance // DANDA_LEN)
points = dandas + 1

print("\nFlight time:", round(time, 2), "seconds")
print("Distance:", round(distance, 1), "metres")
print("Dandas:", dandas)
print("Points (dandas + 1 bonus):", points)
