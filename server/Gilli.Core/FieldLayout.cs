using System.Numerics;

namespace Gilli.Core;

/// <summary>Kind of solid object on the field. The client draws each kind; the server collides with it.</summary>
public enum ObstacleKind { Palm, Neem, Banyan, Hut, TeaShop, Cart, Wall, WaterTank }

/// <summary>
/// A solid object. Cylinders use Radius; boxes use Width/Depth/Height rotated by RotY.
/// Both the C# physics world and the browser scene are built from the same list, so what the
/// player sees is what the gilli and players collide with.
/// </summary>
public sealed record Obstacle(ObstacleKind Kind, float X, float Z, float Radius, float Width, float Depth, float Height, float RotY, float Scale)
{
    public bool IsBox => Kind is ObstacleKind.Hut or ObstacleKind.TeaShop or ObstacleKind.Cart or ObstacleKind.Wall;
}

/// <summary>
/// Single source of truth for the playing field. The pit (kuzhi) is at the origin and the
/// field opens towards -Z. Ported from the original Kitti Pull village layout.
/// </summary>
public sealed class FieldLayout
{
    public Vector2 BoundaryCenter { get; } = new(0, -28);
    public float BoundaryRadius { get; } = 40f;
    /// <summary>Players may walk slightly past the rope to chase a gilli.</summary>
    public float WalkRadius { get; } = 44f;
    public IReadOnlyList<Obstacle> Obstacles { get; }
    public IReadOnlyList<Vector2> FieldingSpots { get; } = new Vector2[] { new(-9, -21), new(8, -15), new(1.5f, -33), new(-3, -10) };
    public IReadOnlyList<Vector2> WaitingSpots { get; } = new Vector2[] { new(-6, 5), new(-7.5f, 5.5f), new(6, 5), new(7.5f, 5.5f) };

    public static FieldLayout Default { get; } = new();

    public FieldLayout()
    {
        var list = new List<Obstacle>();
        static float Face(float x, float z) => MathF.Atan2(-x, -20 - z); // houses face the maidan

        foreach (var (x, z) in new (float, float)[] { (-62, -8), (-66, -24), (-60, -40), (-70, -56), (-56, -74), (63, -12), (70, -30), (-40, 26), (45, 24) })
            list.Add(new Obstacle(ObstacleKind.Hut, x, z, 0, 4.4f, 4.4f, 4.7f, Face(x, z), 1));
        list.Add(new Obstacle(ObstacleKind.TeaShop, 50, -52, 0, 6.2f, 4.6f, 3.6f, Face(50, -52), 1));
        list.Add(new Obstacle(ObstacleKind.Cart, 38, -80, 0, 2.4f, 6.5f, 2.2f, -0.7f, 1));
        list.Add(new Obstacle(ObstacleKind.WaterTank, 82, -98, 2.4f, 0, 0, 15, 0, 1));
        list.Add(new Obstacle(ObstacleKind.Banyan, -46, -96, 1.5f, 0, 0, 9, 0, 1));
        list.Add(new Obstacle(ObstacleKind.Banyan, 46, 14, 1.4f, 0, 0, 9, 0, 0.9f));
        list.Add(new Obstacle(ObstacleKind.Wall, -56, -140, 0, 32, 1.2f, 5, 0, 1));
        list.Add(new Obstacle(ObstacleKind.Wall, 4, -140, 0, 32, 1.2f, 5, 0, 1));
        // neem trees at the edge of the maidan: inside the walking area, so they are in play
        list.Add(new Obstacle(ObstacleKind.Neem, -33, -50, 0.35f, 0, 0, 7, 0, 1));
        list.Add(new Obstacle(ObstacleKind.Neem, 34, -44, 0.35f, 0, 0, 6.5f, 0, 0.9f));
        list.Add(new Obstacle(ObstacleKind.Neem, -24, -66, 0.35f, 0, 0, 7.5f, 0, 1.1f));

        // coconut groves: deterministic so every client and the server agree
        var rng = new Random(20241);
        int placed = 0, tries = 0;
        while (placed < 60 && tries < 2000)
        {
            tries++;
            float a = (float)(rng.NextDouble() * Math.PI * 2), r = 66 + (float)rng.NextDouble() * 70;
            float x = MathF.Sin(a) * r, z = MathF.Cos(a) * r - 15;
            if (!IsFree(list, x, z, 3f)) continue;
            float h = 8 + (float)rng.NextDouble() * 5;
            list.Add(new Obstacle(ObstacleKind.Palm, x, z, 0.22f, 0, 0, h, (float)(rng.NextDouble() * 6.28), 1));
            placed++;
        }
        for (int i = 0; i < 9; i++)
            list.Add(new Obstacle(ObstacleKind.Palm, 55 + i * 11, -96 + (float)(rng.NextDouble() * 2 - 1), 0.22f, 0, 0, 9 + (float)rng.NextDouble() * 3, (float)(rng.NextDouble() * 6.28), 1));
        Obstacles = list;
    }

    static bool IsFree(List<Obstacle> list, float x, float z, float r)
    {
        foreach (var o in list)
        {
            float or = o.IsBox ? MathF.Max(o.Width, o.Depth) * 0.6f : o.Radius + 3;
            if (o.Kind == ObstacleKind.Wall) { if (MathF.Abs(z - o.Z) < 3 && MathF.Abs(x - o.X) < o.Width / 2 + 2) return false; continue; }
            if (o.Kind == ObstacleKind.Banyan) or = 8;
            if (MathF.Sqrt((x - o.X) * (x - o.X) + (z - o.Z) * (z - o.Z)) < or + r) return false;
        }
        return true;
    }

    /// <summary>Clamps a player position into the walkable area and pushes it out of solid objects.</summary>
    public Vector2 ConstrainPlayer(Vector2 p, float playerRadius)
    {
        var d = p - BoundaryCenter;
        float len = d.Length();
        if (len > WalkRadius) p = BoundaryCenter + d / len * WalkRadius;
        foreach (var o in Obstacles)
        {
            if (o.IsBox)
            {
                // to local box space
                float c = MathF.Cos(-o.RotY), s = MathF.Sin(-o.RotY);
                float lx = (p.X - o.X) * c + (p.Y - o.Z) * s;
                float lz = -(p.X - o.X) * s + (p.Y - o.Z) * c;
                // three.js rotation.y convention: x' = x cos + z sin, z' = -x sin + z cos
                float hx = o.Width / 2 + playerRadius, hz = o.Depth / 2 + playerRadius;
                if (MathF.Abs(lx) < hx && MathF.Abs(lz) < hz)
                {
                    float px = hx - MathF.Abs(lx), pz = hz - MathF.Abs(lz);
                    if (px < pz) lx = MathF.CopySign(hx, lx); else lz = MathF.CopySign(hz, lz);
                    float c2 = MathF.Cos(o.RotY), s2 = MathF.Sin(o.RotY);
                    p = new Vector2(o.X + lx * c2 + lz * s2, o.Z - lx * s2 + lz * c2);
                }
            }
            else
            {
                float r = (o.Kind == ObstacleKind.Banyan ? 3.3f * o.Scale : o.Radius) + playerRadius;
                var off = p - new Vector2(o.X, o.Z);
                float l = off.Length();
                if (l < r) p = new Vector2(o.X, o.Z) + (l < 1e-4f ? new Vector2(r, 0) : off / l * r);
            }
        }
        return p;
    }
}
