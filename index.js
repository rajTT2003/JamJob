const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const paypal = require('@paypal/checkout-server-sdk');
const crypto = require('crypto');
const mailjet = require('node-mailjet');
require('dotenv').config();
const port = process.env.PORT || 2000;

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// MongoDB connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@job-portal-jam-jon.vkzrqdc.mongodb.net/?retryWrites=true&w=majority&appName=job-portal-jam-jon`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

// Determine PayPal environment
const environment = process.env.PAYPAL_MODE === 'live' ?
  new paypal.core.LiveEnvironment(
    process.env.PAYPAL_CLIENT_ID,
    process.env.PAYPAL_CLIENT_SECRET
  ) :
  new paypal.core.SandboxEnvironment(
    process.env.PAYPAL_CLIENT_ID,
    process.env.PAYPAL_CLIENT_SECRET
  );

// PayPal Client
const payPalClient = new paypal.core.PayPalHttpClient(environment);

// Create the 'uploads' directory if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Set up multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

async function run() {
  try {
    await client.connect();

    const db = client.db("JamJob");
    const jobsCollection = db.collection("jobs");
    const usersCollection = db.collection("users");

    // Endpoint to create/update user after Google login
    app.post('/api/users', async (req, res) => {
      const { email, googleId, firstName, lastName, gender, dob } = req.body;
      try {
        let user = await usersCollection.findOne({ email });
        if (user) {
          return res.status(409).send({ message: 'User already exists', user });
        } else {
          user = { email, googleId, firstName, lastName, gender, dob, emailVerified: true, totalJobsPosted: 0 };
          await usersCollection.insertOne(user);
          return res.status(201).send({ message: 'User created successfully', user });
        }
      } catch (error) {
        console.error('Error saving user:', error);
        res.status(500).send('Internal server error');
      }
    });

    // Handle file retrieval for company logo
    app.get('/get-logo/uploads/:filename', (req, res) => {
      const filename = req.params.filename;
      res.sendFile(path.join(__dirname, 'uploads', filename));
    });

    // Endpoint to create user after email/password signup
    app.post('/api/signup', async (req, res) => {
      const { email, password } = req.body;
      try {
        let user = await usersCollection.findOne({ email });
        if (user) {
          return res.status(400).send('User already exists');
        }
        user = { email, password, emailVerified: false, totalJobsPosted: 0 };
        await usersCollection.insertOne(user);
        res.status(201).send(user);
      } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).send('Internal server error');
      }
    });

    // POST A JOB
    app.post("/post-job", async (req, res) => {
      const body = req.body;
      body.createAt = new Date();
      const email = body.postedBy;

      try {
        const user = await usersCollection.findOne({ email });

        if (user.totalJobsPosted >= 2) {
          return res.status(402).send({
            message: "Payment required",
            status: false
          });
        }

        const result = await jobsCollection.insertOne(body);

        if (result.insertedId) {
          await usersCollection.updateOne(
            { email },
            { $inc: { totalJobsPosted: 1 } }
          );
          return res.status(200).send(result);
        } else {
          return res.status(500).send({
            message: "Cannot insert, try again later",
            status: false
          });
        }
      } catch (error) {
        console.error('Error posting job:', error);
        res.status(500).send('Internal server error');
      }
    });

    // Endpoint to upload company logo
    app.post('/upload-logo', upload.single('file'), (req, res) => {
      if (!req.file) {
        return res.status(400).send({ message: 'No file uploaded' });
      }
      res.send({ url: `/uploads/${req.file.filename}` });
    });

    // GET ALL JOBS 
    app.get("/all-jobs", async (req, res) => {
      try {
        const jobs = await jobsCollection.find().toArray();
        res.send(jobs);
      } catch (error) {
        console.error('Error fetching jobs:', error);
        res.status(500).send('Internal server error');
      }
    });

    // GET SINGLE JOB USING ID
    app.get("/all-jobs/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const job = await jobsCollection.findOne({
          _id: new ObjectId(id)
        });
        res.send(job);
      } catch (error) {
        console.error('Error fetching job:', error);
        res.status(500).send('Internal server error');
      }
    });

    // GET JOBS BY EMAIL
    app.get("/my-jobs/:email", async (req, res) => {
      try {
        const jobs = await jobsCollection.find({ postedBy: req.params.email }).toArray();
        res.send(jobs);
      } catch (error) {
        console.error('Error fetching jobs:', error);
        res.status(500).send('Internal server error');
      }
    });

    // DELETE A JOB
    app.delete("/job/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const filter = { _id: new ObjectId(id) };
        const result = await jobsCollection.deleteOne(filter);
        res.send(result);
      } catch (error) {
        console.error('Error deleting job:', error);
        res.status(500).send('Internal server error');
      }
    });

    // UPDATE A JOB
    app.patch("/update-job/:id", async (req, res) => {
      const id = req.params.id;
      const jobData = req.body;
      try {
        const filter = { _id: new ObjectId(id) };
        const options = { upsert: true };
        const updateDoc = {
          $set: {
            ...jobData
          },
        };
        const result = await jobsCollection.updateOne(filter, updateDoc, options);
        res.send(result);
      } catch (error) {
        console.error('Error updating job:', error);
        res.status(500).send('Internal server error');
      }
    });

    
    // PayPal payment endpoint
    app.post('/create-paypal-payment', async (req, res) => {
      const request = new paypal.orders.OrdersCreateRequest();
      request.prefer("return=representation");
      request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'USD',
            value: '60.00'
          }
        }],
        application_context: {
          return_url: 'http://localhost:2000/success',
          cancel_url: 'http://localhost:2000/cancel'
        }
      });

      try {
        const order = await payPalClient.execute(request);
        res.send({ forwardLink: order.result.links.find(link => link.rel === 'approve').href });
      } catch (err) {
        console.error('Error creating PayPal payment:', err);
        res.status(500).send({ error: 'Something went wrong' });
      }
    });

    // Ping to confirm successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensure client closes when finished/errors
    // await client.close(); // Uncomment this line if you want to close the client after the server stops
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

    /*
    // Configure Mailjet
    const mailjetClient = mailjet.connect(process.env.MJ_APIKEY_PUBLIC, process.env.MJ_APIKEY_PRIVATE);

    // Generate verification code
    const generateVerificationCode = () => {
      return crypto.randomBytes(3).toString('hex');
    };

    // Function to send verification code
    const sendVerificationCode = async (email, code) => {
      const request = mailjetClient
        .post("send", { 'version': 'v3.1' })
        .request({
          "Messages": [
            {
              "From": {
                "Email": process.env.EMAIL_FROM,
                "Name": "Your App Name"
              },
              "To": [
                {
                  "Email": email,
                  "Name": "User"
                }
              ],
              "Subject": "Email Verification Code",
              "TextPart": `Your verification code is: ${code}`,
              "HTMLPart": `<p>Your verification code is: <strong>${code}</strong></p>`
            }
          ]
        });
      return request;
    };

    // Endpoint to send verification code
    app.post('/api/send-verification-code', async (req, res) => {
      const { email } = req.body;
      try {
        const code = generateVerificationCode();
        const expirationTime = Date.now() + 5 * 60 * 1000; // 5 minutes from now
        let user = await usersCollection.findOne({ email });
        if (!user) {
          return res.status(400).send('User not found');
        }
        await usersCollection.updateOne(
          { email },
          { $set: { verificationCode: code, codeExpiration: expirationTime } }
        );

        await sendVerificationCode(email, code);
        res.status(200).send('Verification code sent');
      } catch (error) {
        console.error('Error sending verification code:', error);
        res.status(500).send('Internal server error');
      }
    });

    // Endpoint to verify email code
    app.post('/api/verify-email-code', async (req, res) => {
      const { email, code } = req.body;
      try {
        let user = await usersCollection.findOne({ email });
        if (!user) {
          return res.status(400).send('User not found');
        }
        if (user.verificationCode === code && Date.now() < user.codeExpiration) {
          await usersCollection.updateOne(
            { email },
            { $set: { emailVerified: true, verificationCode: null, codeExpiration: null } }
          );
          return res.status(200).send({ verified: true });
        }
        res.status(400).send({ verified: false });
      } catch (error) {
        console.error('Error verifying code:', error);
        res.status(500).send('Internal server error');
      }
    });
    */